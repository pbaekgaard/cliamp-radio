import { drainText, extractYouTubeVideoId, parseArtistTitle, YTDLP_COOKIE_ARGS, YTDLP_EXTRA_ARGS } from "./youtube";

// ---------------------------------------------------------------------------
// DEIF FM: a single, always-on "radio" station whose playlist is a live,
// public request queue instead of a fixed list of tracks. Anyone can add a
// YouTube video (after picking a display name — see deifIdentity.ts); videos
// play back-to-back in the order they were added (FIFO, no shuffling) and
// are broadcast to every listener at the same playback position, the same
// way playlistStream.ts does for the fixed-playlist stations. When the
// queue runs dry, playback just pauses (no bytes sent) until the next video
// is added — there's no "idle timeout" teardown here, since this is meant
// to always be ready to pick back up the instant someone queues something.
// ---------------------------------------------------------------------------

export const ICY_METAINT = 16000; // bytes of audio between each ICY metadata block
const AUDIO_ARGS = ["-ar", "44100", "-ac", "2", "-b:a", "128k", "-f", "mp3"];
const MAX_QUEUE_LENGTH = 200; // sane upper bound so the queue can't be spammed into unbounded memory

export interface QueueItem {
  id: number;
  videoId: string;
  url: string;
  artist: string;
  title: string;
  addedBy: string;
  addedAt: number;
}

interface Subscriber {
  controller: ReadableStreamDefaultController<Uint8Array>;
  wantsMeta: boolean;
  bytesSinceMeta: number;
  lastSentMeta: string;
}

function encodeIcyMeta(nowPlaying: string): Uint8Array {
  const text = `StreamTitle='${nowPlaying.replace(/'/g, "")}';`;
  const blockBytes = Math.ceil(text.length / 16) * 16;
  const buf = new Uint8Array(1 + blockBytes);
  buf[0] = blockBytes / 16;
  buf.set(new TextEncoder().encode(text), 1);
  return buf;
}

/** Fetches {title, uploader} for a single YouTube video via yt-dlp. */
async function fetchVideoInfo(url: string): Promise<{ title: string; uploader: string | null }> {
  const proc = Bun.spawn(
    [
      "yt-dlp",
      ...YTDLP_COOKIE_ARGS,
      ...YTDLP_EXTRA_ARGS,
      "--no-playlist",
      "--skip-download",
      "--print",
      "%(title)s\t%(uploader)s",
      url,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [text, stderr] = await Promise.all([new Response(proc.stdout).text(), drainText(proc.stderr)]);
  const exitCode = await proc.exited;
  const [rawTitle, uploader] = text.split("\n")[0]?.split("\t") ?? [];
  if (exitCode !== 0 || !rawTitle) {
    const err = stderr.trim();
    throw new Error(err ? `couldn't look up that video: ${err}` : "couldn't look up that video");
  }
  return { title: rawTitle.trim(), uploader: uploader?.trim() || null };
}

class DeifQueueStream {
  private subscribers = new Set<Subscriber>();
  private queue: QueueItem[] = [];
  private current: QueueItem | null = null;
  private currentMetaString = "";
  private started = false;
  private currentGen = 0;
  private nextId = 1;
  private waiters: Array<() => void> = [];
  private ytdlpProc: ReturnType<typeof Bun.spawn> | null = null;
  private ffmpegProc: ReturnType<typeof Bun.spawn> | null = null;

  get status() {
    return {
      running: this.current !== null,
      listeners: this.subscribers.size,
      nowPlaying: this.current
        ? { id: this.current.id, artist: this.current.artist, title: this.current.title, addedBy: this.current.addedBy }
        : null,
      queueLength: this.queue.length,
    };
  }

  list(): { nowPlaying: QueueItem | null; queue: QueueItem[] } {
    return { nowPlaying: this.current, queue: [...this.queue] };
  }

  /** Starts the perpetual playback loop the first time it's called; safe to call repeatedly. */
  start() {
    if (this.started) return;
    this.started = true;
    this.loop().catch((err) => console.error("[deif-queue] loop crashed:", err));
  }

  subscribe(wantsMeta: boolean): ReadableStream<Uint8Array> {
    const self = this;
    let sub: Subscriber;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        sub = { controller, wantsMeta, bytesSinceMeta: 0, lastSentMeta: "" };
        self.subscribers.add(sub);
      },
      cancel() {
        self.subscribers.delete(sub);
      },
    });
  }

  async addToQueue(url: string, addedBy: string): Promise<QueueItem> {
    const videoId = extractYouTubeVideoId(url);
    if (!videoId) throw new Error("that doesn't look like a YouTube video link");
    if (this.queue.length >= MAX_QUEUE_LENGTH) throw new Error("the queue is full — try again once it's shorter");

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const info = await fetchVideoInfo(videoUrl);
    const { artist, title } = parseArtistTitle(info.title, info.uploader);
    const item: QueueItem = { id: this.nextId++, videoId, url: videoUrl, artist, title, addedBy, addedAt: Date.now() };
    this.queue.push(item);
    this.wakeWaiters();
    this.start();
    return item;
  }

  /** Removes a not-yet-played entry; only the person who added it may remove it. */
  removeFromQueue(id: number, requestedBy: string): { ok: boolean; error?: string } {
    const idx = this.queue.findIndex((q) => q.id === id);
    if (idx === -1) return { ok: false, error: "not found (maybe it's already playing or was removed)" };
    if (this.queue[idx]!.addedBy.toLowerCase() !== requestedBy.toLowerCase()) {
      return { ok: false, error: "you can only remove entries you added" };
    }
    this.queue.splice(idx, 1);
    return { ok: true };
  }

  /** Skips the currently playing track; only the person who added it may skip it. */
  skipCurrent(requestedBy: string): { ok: boolean; error?: string } {
    if (!this.current) return { ok: false, error: "nothing is playing" };
    if (this.current.addedBy.toLowerCase() !== requestedBy.toLowerCase()) {
      return { ok: false, error: "you can only skip entries you added" };
    }
    this.currentGen++; // invalidates the in-flight playEntry loop
    try {
      this.ytdlpProc?.kill();
    } catch {
      // already exited
    }
    try {
      this.ffmpegProc?.kill();
    } catch {
      // already exited
    }
    return { ok: true };
  }

  private wakeWaiters() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  private waitForItem(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private async loop() {
    while (true) {
      if (this.queue.length === 0) {
        this.current = null;
        await this.waitForItem();
        continue;
      }
      const item = this.queue.shift()!;
      this.current = item;
      this.currentMetaString = `${item.artist} - ${item.title}`;
      const gen = ++this.currentGen;
      try {
        await this.playEntry(item, gen);
      } catch (err) {
        console.error(`[deif-queue] failed to play ${item.url}:`, err);
      }
    }
  }

  private async playEntry(entry: QueueItem, gen: number): Promise<void> {
    const ytdlp = Bun.spawn(
      ["yt-dlp", ...YTDLP_COOKIE_ARGS, ...YTDLP_EXTRA_ARGS, "-f", "bestaudio/best", "--no-playlist", "--quiet", "--no-warnings", "-o", "-", entry.url],
      { stdout: "pipe", stderr: "pipe" }
    );
    // `-re` paces ffmpeg's output to the input's native timestamps (real
    // playback speed) so listeners hear the actual song duration instead of
    // the whole thing blowing through as fast as the CPU/network allow.
    const ffmpeg = Bun.spawn(
      ["ffmpeg", "-hide_banner", "-loglevel", "error", "-re", "-i", "pipe:0", "-vn", ...AUDIO_ARGS, "pipe:1"],
      { stdin: ytdlp.stdout, stdout: "pipe", stderr: "pipe" }
    );
    this.ytdlpProc = ytdlp;
    this.ffmpegProc = ffmpeg;

    const ytdlpStderr = drainText(ytdlp.stderr);
    const ffmpegStderr = drainText(ffmpeg.stderr);

    try {
      const reader = ffmpeg.stdout.getReader();
      while (true) {
        if (this.currentGen !== gen) return; // skipped mid-track
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) this.broadcast(value);
      }
      const [ffExit, ytExit] = await Promise.all([ffmpeg.exited, ytdlp.exited]);
      if (ffExit !== 0 && this.currentGen === gen) {
        const ytErr = (await ytdlpStderr).trim();
        const ffErr = (await ffmpegStderr).trim();
        throw new Error(
          `ffmpeg exited with code ${ffExit} (yt-dlp exited ${ytExit})` +
            (ytErr ? `\nyt-dlp stderr: ${ytErr}` : "") +
            (ffErr ? `\nffmpeg stderr: ${ffErr}` : "")
        );
      }
    } finally {
      this.ytdlpProc = null;
      this.ffmpegProc = null;
      try {
        ytdlp.kill();
      } catch {
        // already exited
      }
      try {
        ffmpeg.kill();
      } catch {
        // already exited
      }
    }
  }

  private broadcast(chunk: Uint8Array) {
    for (const sub of this.subscribers) {
      try {
        if (!sub.wantsMeta) {
          sub.controller.enqueue(chunk);
          continue;
        }
        this.pushWithMeta(sub, chunk);
      } catch {
        this.subscribers.delete(sub);
      }
    }
  }

  private pushWithMeta(sub: Subscriber, chunk: Uint8Array) {
    let offset = 0;
    while (offset < chunk.length) {
      const remaining = ICY_METAINT - sub.bytesSinceMeta;
      const take = Math.min(remaining, chunk.length - offset);
      sub.controller.enqueue(chunk.subarray(offset, offset + take));
      offset += take;
      sub.bytesSinceMeta += take;
      if (sub.bytesSinceMeta >= ICY_METAINT) {
        sub.bytesSinceMeta = 0;
        if (this.currentMetaString !== sub.lastSentMeta) {
          sub.controller.enqueue(encodeIcyMeta(this.currentMetaString));
          sub.lastSentMeta = this.currentMetaString;
        } else {
          sub.controller.enqueue(new Uint8Array([0])); // "no metadata change" marker
        }
      }
    }
  }

  /** Kills any in-flight yt-dlp/ffmpeg pair — called on process shutdown. */
  stop() {
    try {
      this.ytdlpProc?.kill();
    } catch {
      // ignore
    }
    try {
      this.ffmpegProc?.kill();
    } catch {
      // ignore
    }
  }
}

export const deifQueueStream = new DeifQueueStream();
