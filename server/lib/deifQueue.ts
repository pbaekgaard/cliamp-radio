import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
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
const UPLOADS_DIR = path.join(import.meta.dir, "..", "data", "deif-uploads");
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024; // 30MB — generous for an mp3, bounded so uploads can't fill the disk
// A "listener" is anyone whose /deif page has polled the queue within this
// window (see index.ts, which touches presence on every GET /api/deif/queue
// — the page already polls every few seconds, so this doubles as a
// heartbeat with no extra requests). Used both for the listeners list and
// as the denominator for the skip-vote majority below.
const PRESENCE_TTL_MS = 20_000;

export interface QueueItem {
  id: number;
  videoId: string;
  url: string;
  artist: string;
  title: string;
  addedBy: string;
  addedAt: number;
  /** "youtube" (default) plays via yt-dlp; "upload" plays a locally-stored
   * mp3 (see uploadFiles below) that's deleted once it's done playing. */
  source: "youtube" | "upload";
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

/** Best-effort {artist, title} guess from an uploaded file's name, mirroring
 * parseArtistTitle()'s "Artist - Title" convention for YouTube titles. */
function titleFromFilename(filename: string): { artist: string; title: string } {
  const base = filename.replace(/\.[^./]+$/, "").replace(/[_]+/g, " ").trim();
  const idx = base.indexOf(" - ");
  if (idx > 0) return { artist: base.slice(0, idx).trim(), title: base.slice(idx + 3).trim() };
  return { artist: "Uploaded", title: base || "Untitled upload" };
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
  private presence = new Map<string, number>(); // name -> last-seen timestamp
  private skipVotes = new Set<string>(); // names who voted to skip the current track
  private uploadFiles = new Map<number, string>(); // queue item id -> on-disk path, for uploaded mp3s

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

  /** Records that `name` is actively viewing the DEIF FM page right now. */
  touchPresence(name: string) {
    this.presence.set(name, Date.now());
  }

  /** Names seen within PRESENCE_TTL_MS, sorted; also prunes stale entries. */
  private activeListenerNames(): string[] {
    const now = Date.now();
    const names: string[] = [];
    for (const [name, lastSeen] of this.presence) {
      if (now - lastSeen <= PRESENCE_TTL_MS) names.push(name);
      else this.presence.delete(name);
    }
    return names.sort((a, b) => a.localeCompare(b));
  }

  list(viewerName?: string): {
    nowPlaying: QueueItem | null;
    queue: QueueItem[];
    listeners: string[];
    skipVote: { votes: number; total: number; hasVoted: boolean };
  } {
    if (viewerName) this.touchPresence(viewerName);
    const listeners = this.activeListenerNames();
    return {
      nowPlaying: this.current,
      queue: [...this.queue],
      listeners,
      skipVote: {
        votes: this.skipVotes.size,
        total: Math.max(listeners.length, 1),
        hasVoted: !!viewerName && this.skipVotes.has(viewerName.toLowerCase()),
      },
    };
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
    const item: QueueItem = {
      id: this.nextId++,
      videoId,
      url: videoUrl,
      artist,
      title,
      addedBy,
      addedAt: Date.now(),
      source: "youtube",
    };
    this.queue.push(item);
    this.wakeWaiters();
    this.start();
    return item;
  }

  /**
   * Saves an uploaded mp3 to disk and adds it to the queue. The file is
   * deleted once it's done playing (see loop()) or if it's removed from
   * the queue before its turn (see removeFromQueue()) — uploads never
   * linger on disk longer than they need to.
   */
  async addUploadToQueue(file: File, addedBy: string): Promise<QueueItem> {
    if (this.queue.length >= MAX_QUEUE_LENGTH) throw new Error("the queue is full — try again once it's shorter");
    const name = file.name || "upload.mp3";
    const looksLikeMp3 = /\.mp3$/i.test(name) || file.type === "audio/mpeg" || file.type === "audio/mp3";
    if (!looksLikeMp3) throw new Error("only .mp3 files are supported");
    if (file.size <= 0) throw new Error("that file looks empty");
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error(`that file is too big (max ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB)`);
    }

    await mkdir(UPLOADS_DIR, { recursive: true });
    const id = this.nextId++;
    const diskPath = path.join(UPLOADS_DIR, `${id}-${crypto.randomUUID()}.mp3`);
    await writeFile(diskPath, new Uint8Array(await file.arrayBuffer()));
    this.uploadFiles.set(id, diskPath);

    const { artist, title } = titleFromFilename(name);
    const item: QueueItem = { id, videoId: "", url: "", artist, title, addedBy, addedAt: Date.now(), source: "upload" };
    this.queue.push(item);
    this.wakeWaiters();
    this.start();
    return item;
  }

  /** Deletes an uploaded mp3's on-disk file, if any; a no-op for YouTube entries. */
  private async cleanupUpload(id: number) {
    const filePath = this.uploadFiles.get(id);
    if (!filePath) return;
    this.uploadFiles.delete(id);
    try {
      await rm(filePath, { force: true });
    } catch (err) {
      console.error(`[deif-queue] failed to delete uploaded file ${filePath}:`, err);
    }
  }

  /** Removes a not-yet-played entry; only the person who added it may remove it. */
  removeFromQueue(id: number, requestedBy: string): { ok: boolean; error?: string } {
    const idx = this.queue.findIndex((q) => q.id === id);
    if (idx === -1) return { ok: false, error: "not found (maybe it's already playing or was removed)" };
    if (this.queue[idx]!.addedBy.toLowerCase() !== requestedBy.toLowerCase()) {
      return { ok: false, error: "you can only remove entries you added" };
    }
    const [removed] = this.queue.splice(idx, 1);
    if (removed?.source === "upload") this.cleanupUpload(removed.id).catch(() => {});
    return { ok: true };
  }

  /**
   * Skips the currently playing track. The person who added it can skip it
   * instantly (they get to change their mind); anyone else instead casts a
   * vote, and the track is skipped as soon as votes reach a majority of
   * currently-present listeners — or an exact 50/50 split, since a tie
   * means at least half the room wants it gone.
   */
  requestSkip(requestedBy: string): {
    ok: boolean;
    error?: string;
    skipped?: boolean;
    votes?: number;
    total?: number;
    hasVoted?: boolean;
  } {
    if (!this.current) return { ok: false, error: "nothing is playing" };
    const name = requestedBy.toLowerCase();

    if (this.current.addedBy.toLowerCase() === name) {
      this.killPlayback();
      return { ok: true, skipped: true };
    }

    // Toggle: voting again removes your vote, in case you change your mind.
    if (this.skipVotes.has(name)) this.skipVotes.delete(name);
    else this.skipVotes.add(name);

    const total = Math.max(this.activeListenerNames().length, 1);
    const votes = this.skipVotes.size;
    if (votes * 2 >= total) {
      this.skipVotes.clear();
      this.killPlayback();
      return { ok: true, skipped: true };
    }
    return { ok: true, skipped: false, votes, total, hasVoted: this.skipVotes.has(name) };
  }

  /** Kills the in-flight yt-dlp/ffmpeg pair, which ends the current track's playback loop. */
  private killPlayback() {
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
      this.skipVotes.clear();
      const gen = ++this.currentGen;
      try {
        await this.playEntry(item, gen);
      } catch (err) {
        console.error(`[deif-queue] failed to play ${item.source === "upload" ? item.title : item.url}:`, err);
      } finally {
        if (item.source === "upload") this.cleanupUpload(item.id).catch(() => {});
      }
    }
  }

  private async playEntry(entry: QueueItem, gen: number): Promise<void> {
    if (entry.source === "upload") return this.playUpload(entry, gen);

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

  /** Plays a locally-uploaded mp3 straight through ffmpeg (no yt-dlp needed). */
  private async playUpload(entry: QueueItem, gen: number): Promise<void> {
    const filePath = this.uploadFiles.get(entry.id);
    if (!filePath) throw new Error("uploaded file is missing");

    // `-re` paces output to real playback speed, same as the YouTube path.
    const ffmpeg = Bun.spawn(
      ["ffmpeg", "-hide_banner", "-loglevel", "error", "-re", "-i", filePath, "-vn", ...AUDIO_ARGS, "pipe:1"],
      { stdout: "pipe", stderr: "pipe" }
    );
    this.ytdlpProc = null;
    this.ffmpegProc = ffmpeg;
    const ffmpegStderr = drainText(ffmpeg.stderr);

    try {
      const reader = ffmpeg.stdout.getReader();
      while (true) {
        if (this.currentGen !== gen) return; // skipped mid-track
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) this.broadcast(value);
      }
      const ffExit = await ffmpeg.exited;
      if (ffExit !== 0 && this.currentGen === gen) {
        const ffErr = (await ffmpegStderr).trim();
        throw new Error(`ffmpeg exited with code ${ffExit}` + (ffErr ? `\nffmpeg stderr: ${ffErr}` : ""));
      }
    } finally {
      this.ffmpegProc = null;
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
