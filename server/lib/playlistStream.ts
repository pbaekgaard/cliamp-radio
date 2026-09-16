import { parseArtistTitle } from "./youtube";

// ---------------------------------------------------------------------------
// Turns a YouTube playlist URL into a single, always-live radio stream:
// videos are pulled one at a time via yt-dlp, transcoded to a continuous MP3
// stream via ffmpeg, played back in shuffled order on an infinite loop, and
// fanned out to every connected listener at the same playback position (like
// a real Icecast/Shoutcast station) with ICY "StreamTitle" metadata carrying
// the current artist/title. This is what lets several people tune in to the
// same station URL and hear the same thing at the same time.
// ---------------------------------------------------------------------------

export const ICY_METAINT = 16000; // bytes of audio between each ICY metadata block
const AUDIO_ARGS = ["-ar", "44100", "-ac", "2", "-b:a", "128k", "-f", "mp3"];
const IDLE_STOP_MS = 5 * 60 * 1000; // stop transcoding this many ms after the last listener leaves
const PLAYLIST_REFRESH_MS = 6 * 60 * 60 * 1000; // re-fetch the playlist's video list at most this often
const MAX_CONSECUTIVE_FAILURES = 5; // give up (rather than spin forever) after this many bad videos in a row

// YouTube increasingly blocks requests from datacenter/VPS IPs with "Sign in
// to confirm you're not a bot" unless yt-dlp presents cookies from a real,
// signed-in browser session. Two ways to supply them, checked in this order:
//
// 1. YTDLP_COOKIES_FROM_BROWSER (recommended): a value like
//    "chromium:/path/to/profile-dir" pointing at a real browser profile kept
//    logged into a Google account on this machine. yt-dlp reads cookies
//    live from that profile on every single request, so — unlike a static
//    file — this never goes stale on its own; it just keeps working for as
//    long as that browser profile stays logged in (typically months), with
//    no manual re-export/copy step ever required. See README.md for how to
//    set this up once.
// 2. YTDLP_COOKIES_FILE: a static Netscape-format cookies.txt (exported via
//    a browser extension). Simpler to set up, but it's a point-in-time
//    snapshot that WILL eventually expire and need re-exporting by hand —
//    only use this if setting up a persistent browser profile isn't
//    practical for you.
const YTDLP_COOKIES_FROM_BROWSER = process.env.YTDLP_COOKIES_FROM_BROWSER || null;
const YTDLP_COOKIES_FILE = process.env.YTDLP_COOKIES_FILE || null;
const YTDLP_COOKIE_ARGS = YTDLP_COOKIES_FROM_BROWSER
  ? ["--cookies-from-browser", YTDLP_COOKIES_FROM_BROWSER]
  : YTDLP_COOKIES_FILE
    ? ["--cookies", YTDLP_COOKIES_FILE]
    : [];

interface PlaylistEntry {
  id: string;
  url: string;
  artist: string;
  title: string;
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

const MAX_STDERR_CHARS = 4000; // cap so a runaway/looping process can't bloat memory or logs

// Reads an entire stderr stream to text, bounded so a chatty or runaway
// process can't grow unbounded in memory. Used purely for error reporting
// when a subprocess fails — normal/successful runs never have this text
// looked at.
async function drainText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  try {
    const text = await new Response(stream).text();
    return text.length > MAX_STDERR_CHARS ? `…${text.slice(-MAX_STDERR_CHARS)}` : text;
  } catch {
    return "";
  }
}

async function fetchPlaylistEntries(playlistUrl: string): Promise<PlaylistEntry[]> {
  const proc = Bun.spawn(
    [
      "yt-dlp",
      ...YTDLP_COOKIE_ARGS,
      "--flat-playlist",
      "--ignore-errors",
      "--print",
      "%(id)s\t%(title)s\t%(uploader)s",
      playlistUrl,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [text, stderr] = await Promise.all([new Response(proc.stdout).text(), drainText(proc.stderr)]);
  await proc.exited;

  const entries: PlaylistEntry[] = [];
  for (const line of text.split("\n")) {
    const [id, rawTitle, uploader] = line.split("\t");
    if (!id || !rawTitle) continue;
    if (/^\[(Private|Deleted|Unavailable)/i.test(rawTitle)) continue;
    const { artist, title } = parseArtistTitle(rawTitle, uploader || null);
    entries.push({ id, url: `https://www.youtube.com/watch?v=${id}`, artist, title });
  }
  if (entries.length === 0 && stderr.trim()) {
    console.error(`[playlist-stream] yt-dlp produced no entries for ${playlistUrl}\nyt-dlp stderr: ${stderr.trim()}`);
  }
  return entries;
}

class PlaylistStream {
  readonly playlistId: string;
  readonly playlistUrl: string;

  private subscribers = new Set<Subscriber>();
  private entries: PlaylistEntry[] = [];
  private entriesFetchedAt = 0;
  private queue: PlaylistEntry[] = [];
  private current: PlaylistEntry | null = null;
  private currentMetaString = "";
  private running = false;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private ytdlpProc: ReturnType<typeof Bun.spawn> | null = null;
  private ffmpegProc: ReturnType<typeof Bun.spawn> | null = null;
  // Bumped every time playback is torn down (idle timeout or shutdown) so a
  // still-in-flight playback loop from a previous "generation" knows to stop
  // touching shared state instead of racing a freshly started one.
  private generation = 0;

  constructor(playlistId: string, playlistUrl: string) {
    this.playlistId = playlistId;
    this.playlistUrl = playlistUrl;
  }

  get status() {
    return {
      running: this.running,
      listeners: this.subscribers.size,
      nowPlaying: this.current ? { artist: this.current.artist, title: this.current.title } : null,
    };
  }

  subscribe(wantsMeta: boolean): ReadableStream<Uint8Array> {
    const self = this;
    let sub: Subscriber;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        sub = { controller, wantsMeta, bytesSinceMeta: 0, lastSentMeta: "" };
        self.subscribers.add(sub);
        self.cancelIdleStop();
        self.ensureRunning();
      },
      cancel() {
        self.subscribers.delete(sub);
        if (self.subscribers.size === 0) self.scheduleIdleStop();
      },
    });
  }

  private ensureRunning() {
    if (this.running) return;
    this.running = true;
    const gen = ++this.generation;
    this.loop(gen).catch((err) => {
      console.error(`[playlist-stream:${this.playlistId}] loop crashed:`, err);
    });
  }

  private async loop(gen: number) {
    let consecutiveFailures = 0;
    try {
      while (this.generation === gen) {
        if (this.subscribers.size === 0) break; // ensureRunning() restarts this when someone next tunes in

        await this.refreshEntriesIfNeeded();
        if (this.entries.length === 0) {
          console.error(`[playlist-stream:${this.playlistId}] no playable videos found in playlist`);
          break;
        }
        if (this.queue.length === 0) this.reshuffle();

        const entry = this.queue.shift()!;
        this.current = entry;
        this.currentMetaString = `${entry.artist} - ${entry.title}`;

        try {
          await this.playEntry(entry, gen);
          consecutiveFailures = 0;
        } catch (err) {
          if (this.generation !== gen) break; // torn down while playing — not a real failure
          consecutiveFailures++;
          console.error(`[playlist-stream:${this.playlistId}] failed to play ${entry.url}:`, err);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            console.error(`[playlist-stream:${this.playlistId}] too many consecutive failures, giving up`);
            break;
          }
        }
      }
    } finally {
      if (this.generation === gen) {
        this.running = false;
        this.current = null;
      }
    }
  }

  private reshuffle() {
    const shuffled = [...this.entries];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    // Avoid immediately repeating the track that just finished when the
    // shuffle happens to put it first again.
    if (shuffled.length > 1 && this.current && shuffled[0]!.id === this.current.id) {
      [shuffled[0], shuffled[1]] = [shuffled[1]!, shuffled[0]!];
    }
    this.queue = shuffled;
  }

  private async refreshEntriesIfNeeded() {
    if (this.entries.length > 0 && Date.now() - this.entriesFetchedAt < PLAYLIST_REFRESH_MS) return;
    try {
      const fresh = await fetchPlaylistEntries(this.playlistUrl);
      if (fresh.length > 0) {
        this.entries = fresh;
        this.entriesFetchedAt = Date.now();
        this.queue = []; // reshuffle against the fresh list next
      }
    } catch (err) {
      console.error(`[playlist-stream:${this.playlistId}] failed to fetch playlist entries:`, err);
    }
  }

  private async playEntry(entry: PlaylistEntry, gen: number): Promise<void> {
    const ytdlp = Bun.spawn(
      [
        "yt-dlp",
        ...YTDLP_COOKIE_ARGS,
        "-f",
        "bestaudio/best",
        "--no-playlist",
        "--quiet",
        "--no-warnings",
        "-o",
        "-",
        entry.url,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const ffmpeg = Bun.spawn(
      // `-re` paces ffmpeg's output to the input's native timestamps (real
      // playback speed) instead of transcoding as fast as the CPU/network
      // allow — without it, the whole shuffled queue would blow through in
      // seconds instead of the actual song durations, which would defeat
      // the point of listeners sharing one live playback position.
      ["ffmpeg", "-hide_banner", "-loglevel", "error", "-re", "-i", "pipe:0", "-vn", ...AUDIO_ARGS, "pipe:1"],
      { stdin: ytdlp.stdout, stdout: "pipe", stderr: "pipe" }
    );
    this.ytdlpProc = ytdlp;
    this.ffmpegProc = ffmpeg;

    // Both processes' stderr streams are collected in the background (not
    // logged as they arrive — yt-dlp/ffmpeg can be noisy) so that if either
    // one fails, we can log the actual error text instead of just an
    // opaque exit code that's nearly impossible to debug from alone.
    const ytdlpStderr = drainText(ytdlp.stderr);
    const ffmpegStderr = drainText(ffmpeg.stderr);

    try {
      const reader = ffmpeg.stdout.getReader();
      while (true) {
        if (this.generation !== gen) return; // stopped/torn down mid-track
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) this.broadcast(value);
      }
      const [ffExit, ytExit] = await Promise.all([ffmpeg.exited, ytdlp.exited]);
      if (ffExit !== 0 && this.generation === gen) {
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
        // controller errored (client gone) — drop them; the ReadableStream's
        // own `cancel` callback handles unsubscribing/idle-timeout bookkeeping.
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

  private scheduleIdleStop() {
    this.cancelIdleStop();
    this.stopTimer = setTimeout(() => this.stop(), IDLE_STOP_MS);
  }

  private cancelIdleStop() {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
  }

  stop() {
    this.cancelIdleStop();
    this.generation++; // invalidates any in-flight loop/playEntry for the old generation
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
    this.running = false;
    this.current = null;
    this.queue = [];
  }
}

const streams = new Map<string, PlaylistStream>();

export function getOrCreatePlaylistStream(playlistId: string, playlistUrl: string): PlaylistStream {
  let stream = streams.get(playlistId);
  if (!stream) {
    stream = new PlaylistStream(playlistId, playlistUrl);
    streams.set(playlistId, stream);
  }
  return stream;
}

export function getPlaylistStreamStatus(playlistId: string) {
  return streams.get(playlistId)?.status ?? { running: false, listeners: 0, nowPlaying: null };
}

/** Kills every running yt-dlp/ffmpeg pair — called on process shutdown. */
export function stopAllPlaylistStreams() {
  for (const stream of streams.values()) stream.stop();
}
