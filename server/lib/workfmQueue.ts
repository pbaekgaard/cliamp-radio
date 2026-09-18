import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { attachSavedUpload, getLibraryTrack, listMostLiked, recordPlay, registerUpload, SAVED_UPLOAD_TTL_MS, SAVED_UPLOADS_DIR, type LibraryTrack } from "./workfmLibrary";
import { drainText, extractYouTubeVideoId, parseArtistTitle, YTDLP_COOKIE_ARGS, YTDLP_EXTRA_ARGS } from "./youtube";

// ---------------------------------------------------------------------------
// WorkFM: an always-on "radio" queue engine whose playlist is a live,
// public request queue instead of a fixed list of tracks. Anyone can add a
// YouTube video (after picking a display name — see workfmIdentity.ts); videos
// play back-to-back in the order they were added (FIFO, no shuffling) and
// are broadcast to every listener at the same playback position, the same
// way playlistStream.ts does for the fixed-playlist stations. When the
// queue runs dry, playback just pauses (no bytes sent) until the next video
// is added — there's no "idle timeout" teardown of *playback* here, since
// this is meant to always be ready to pick back up the instant someone
// queues something. (Whole *rooms* — see workfmRooms.ts, which each own one
// WorkFmQueueStream instance — do get torn down after being empty a while.)
// ---------------------------------------------------------------------------

export const ICY_METAINT = 16000; // bytes of audio between each ICY metadata block
const AUDIO_ARGS = ["-ar", "44100", "-ac", "2", "-b:a", "128k", "-f", "mp3"];
const MAX_QUEUE_LENGTH = 200; // sane upper bound so the queue can't be spammed into unbounded memory
const UPLOADS_DIR = path.join(import.meta.dir, "..", "data", "workfm-uploads");
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024; // 30MB — generous for an mp3, bounded so uploads can't fill the disk
const MAX_CHAT_MESSAGES = 100; // per room — oldest messages roll off once exceeded
const MAX_CHAT_MESSAGE_LENGTH = 500;
// How long a named visitor is considered "in the room" after their last
// GET /queue poll (see touchPresence()/list() below) before they're
// considered gone — comfortably longer than the client's ~1.5s poll
// interval so a slow network blip doesn't make someone flicker in and out.
const PRESENCE_TIMEOUT_MS = 10 * 1000;
// A "listener" is someone whose browser currently has an open connection to
// the actual audio stream (i.e. they clicked "Listen live" and are still
// playing it, or are tuned in via cliamp) — see subscribe() below. Merely
// having the /workfm page open (which polls the queue for now-playing/queue
// updates) does *not* count; that would inflate the count with people who
// are just browsing the page without actually listening. Used both for the
// listeners list and as the denominator for the skip-vote majority below.

export interface QueueItem {
  id: number;
  videoId: string;
  url: string;
  artist: string;
  title: string;
  addedBy: string;
  addedAt: number;
  /** "youtube" (default) plays via yt-dlp; "upload" plays a locally-stored
   * mp3 (see diskPath) that's deleted once it's done playing, unless
   * saveForLater is set (see addUploadToQueue). */
  source: "youtube" | "upload";
  /** Stable id used for likes/history/most-liked/requeue in workfmLibrary.ts:
   * "yt:<videoId>" (shared across every room/queue of the same video) or
   * "up:<uuid>" (unique per upload). */
  libraryId: string;
  /** Upload-only: whether to persist the file to workfmLibrary's saved-uploads
   * store after it finishes playing, instead of deleting it right away. */
  saveForLater?: boolean;
  /** Upload-only: where the file currently lives on disk — either this
   * room's fresh-upload dir, or workfmLibrary's persistent saved-uploads dir
   * (for tracks requeued from the library). */
  diskPath?: string;
}

interface ChatMessage {
  id: number;
  name: string;
  text: string;
  at: number;
}

interface Subscriber {
  controller: ReadableStreamDefaultController<Uint8Array>;
  wantsMeta: boolean;
  bytesSinceMeta: number;
  lastSentMeta: string;
  /** The listener's WorkFM display name, if they'd identified themselves before tuning in. */
  name?: string;
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

class WorkFmQueueStream {
  private subscribers = new Set<Subscriber>();
  private queue: QueueItem[] = [];
  private current: QueueItem | null = null;
  private currentMetaString = "";
  private started = false;
  private currentGen = 0;
  private nextId = 1;
  private ytdlpProc: ReturnType<typeof Bun.spawn> | null = null;
  private ffmpegProc: ReturnType<typeof Bun.spawn> | null = null;
  private skipVotes = new Set<string>(); // names who voted to skip the current track
  private repeatVotes = new Set<string>(); // names who voted to repeat the current track
  private repeatArmed = false; // whether the current track will replay itself once it finishes
  private uploadFiles = new Map<number, string>(); // queue item id -> on-disk path, for uploaded mp3s
  private chat: ChatMessage[] = [];
  private nextChatId = 1;
  // name -> last time (ms since epoch) they polled GET /queue for this room.
  // This is how "who's in the room" is tracked — separate from who's
  // actually streaming audio (subscribers) — see touchPresence()/members().
  private presence = new Map<string, number>();
  // Timestamp since this room has had nobody around at all (no audio-stream
  // subscribers AND nobody polling the page — see emptySince getter below),
  // or null while someone's present. Starts "empty" at construction —
  // workfmRooms.ts uses this to auto-remove rooms nobody's actually using.
  private _emptySince: number | null = Date.now();

  get status() {
    return {
      running: this.current !== null,
      listeners: this.subscribers.size,
      members: this.activeMemberNames().length,
      nowPlaying: this.current
        ? { id: this.current.id, artist: this.current.artist, title: this.current.title, addedBy: this.current.addedBy }
        : null,
      queueLength: this.queue.length,
    };
  }

  /** How long (ms since epoch) this room has had nobody around — neither
   * streaming the audio nor with the page open — or null if anyone's
   * present right now. Recomputed on access (see activeMemberNames()),
   * so it stays accurate even if nobody's polled recently. */
  get emptySince(): number | null {
    const isEmpty = this.subscribers.size === 0 && this.activeMemberNames().length === 0;
    if (isEmpty) {
      if (this._emptySince === null) this._emptySince = Date.now();
    } else {
      this._emptySince = null;
    }
    return this._emptySince;
  }

  /** Records that `name` just polled the room (i.e. has the page open),
   * refreshing how long they count as "in the room" — see PRESENCE_TIMEOUT_MS. */
  private touchPresence(name?: string) {
    if (!name) return;
    this.presence.set(name, Date.now());
  }

  /** Distinct names who've polled within PRESENCE_TIMEOUT_MS, sorted —
   * expired entries are garbage-collected as a side effect. This is "who's
   * actually in the room right now", independent of whether they're
   * streaming the audio. */
  private activeMemberNames(): string[] {
    const now = Date.now();
    const names: string[] = [];
    for (const [name, lastSeen] of this.presence) {
      if (now - lastSeen > PRESENCE_TIMEOUT_MS) this.presence.delete(name);
      else names.push(name);
    }
    return names.sort((a, b) => a.localeCompare(b));
  }

  /** Distinct display names of everyone currently connected to the actual audio
   * stream (subscribers with a name), sorted. Anonymous stream connections
   * (nobody identified yet) are still played to, just not named here — see
   * anonymousListenerCount() for those. */
  private listenerNames(): string[] {
    const names = new Set<string>();
    for (const sub of this.subscribers) {
      if (sub.name) names.add(sub.name);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  /** Count of audio-stream connections with no WorkFM identity attached — this
   * is how cliamp (the desktop/native player, which just requests the raw
   * mp3 stream and never carries a browser session cookie) shows up, as
   * well as anyone browsing /workfm and hitting "Listen live" without joining. */
  private anonymousListenerCount(): number {
    let count = 0;
    for (const sub of this.subscribers) {
      if (!sub.name) count++;
    }
    return count;
  }

  /** Attaches global (cross-room) like info from the library to a queue
   * item, keyed by its libraryId — so "like the song" works the instant a
   * track starts/queues, without a separate library lookup round-trip.
   * Falls back to zero/false for tracks that haven't hit the library yet
   * (i.e. still queued, never actually played). */
  private withLikes(item: QueueItem, viewerName?: string): QueueItem & { likes: number; likedByMe: boolean } {
    const entry = getLibraryTrack(item.libraryId);
    const likes = entry?.likes.length ?? 0;
    const likedByMe = !!viewerName && !!entry?.likes.includes(viewerName.toLowerCase());
    return { ...item, likes, likedByMe };
  }

  /** Top 5 (by like count) songs across *every* WorkFM room — unlike the
   * old room-scoped version, this is just the global "most liked" library
   * view (already filtered to tracks with at least one like), reshaped to
   * the room queue's leaderboard entry shape. */
  private roomLeaderboard(
    viewerName: string | undefined,
    limit = 5
  ): {
    libraryId: string;
    title: string;
    artist: string;
    likes: number;
    likedByMe: boolean;
    addedBy: string;
    available: boolean;
  }[] {
    return listMostLiked(viewerName, limit).map((e) => ({
      libraryId: e.id,
      title: e.title,
      artist: e.artist,
      likes: e.likes,
      likedByMe: e.likedByMe,
      addedBy: e.addedBy,
      available: e.available,
    }));
  }

  list(viewerName?: string): {
    nowPlaying: (QueueItem & { likes: number; likedByMe: boolean }) | null;
    queue: (QueueItem & { likes: number; likedByMe: boolean })[];
    listeners: string[];
    anonymousListeners: number;
    members: { name: string; listening: boolean }[];
    leaderboard: ReturnType<WorkFmQueueStream["roomLeaderboard"]>;
    skipVote: { votes: number; total: number; hasVoted: boolean };
    repeatVote: { armed: boolean; votes: number; total: number; hasVoted: boolean };
    chat: ChatMessage[];
  } {
    this.touchPresence(viewerName);
    const listeners = this.listenerNames();
    const listening = new Set(listeners);
    const members = this.activeMemberNames().map((name) => ({ name, listening: listening.has(name) }));
    return {
      nowPlaying: this.current ? this.withLikes(this.current, viewerName) : null,
      queue: this.queue.map((item) => this.withLikes(item, viewerName)),
      listeners,
      anonymousListeners: this.anonymousListenerCount(),
      members,
      leaderboard: this.roomLeaderboard(viewerName),
      skipVote: {
        votes: this.skipVotes.size,
        total: Math.max(listeners.length, 1),
        hasVoted: !!viewerName && this.skipVotes.has(viewerName.toLowerCase()),
      },
      repeatVote: {
        armed: this.repeatArmed,
        votes: this.repeatVotes.size,
        total: Math.max(listeners.length, 1),
        hasVoted: !!viewerName && this.repeatVotes.has(viewerName.toLowerCase()),
      },
      chat: this.chat,
    };
  }


  /** Posts a chat message from `name`; trims/caps length and rolls off the
   * oldest message once MAX_CHAT_MESSAGES is exceeded. */
  postChatMessage(name: string, text: string): ChatMessage {
    const trimmed = text.trim().slice(0, MAX_CHAT_MESSAGE_LENGTH);
    if (!trimmed) throw new Error("message can't be empty");
    const message: ChatMessage = { id: this.nextChatId++, name, text: trimmed, at: Date.now() };
    this.chat.push(message);
    if (this.chat.length > MAX_CHAT_MESSAGES) this.chat.shift();
    return message;
  }

  /** Starts the perpetual playback loop the first time it's called; safe to call repeatedly. */
  start() {
    if (this.started) return;
    this.started = true;
    this.loop().catch((err) => console.error("[workfm-queue] loop crashed:", err));
  }

  /** `name` is the listener's WorkFM display name (if identified) — passed in
   * from the request's identity cookie in index.ts so the listeners list
   * only reflects people actually tuned into the audio stream, not just
   * anyone with the /workfm page open. */
  subscribe(wantsMeta: boolean, name?: string): ReadableStream<Uint8Array> {
    const self = this;
    let sub: Subscriber;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        sub = { controller, wantsMeta, bytesSinceMeta: 0, lastSentMeta: "", name };
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
      libraryId: `yt:${videoId}`,
    };
    this.queue.push(item);
    this.start();
    return item;
  }

  /**
   * Saves an uploaded mp3 to disk and adds it to the queue. If `saveForLater`
   * is set, a persistent copy is written into workfmLibrary's saved-uploads
   * store *right away* (not just once it finishes playing) — so it shows up
   * under "Saved uploads"/"Most liked" and is requeueable immediately,
   * regardless of how long it sits in the queue first. Either way, this
   * room's own temporary copy is deleted once its turn is done (see the
   * `finally` block in loop()).
   */
  async addUploadToQueue(
    file: File,
    addedBy: string,
    saveForLater = true,
    overrides?: { title?: string; artist?: string },
  ): Promise<QueueItem> {
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
    const libraryId = `up:${crypto.randomUUID()}`;
    const diskPath = path.join(UPLOADS_DIR, `${id}-${crypto.randomUUID()}.mp3`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    await writeFile(diskPath, bytes);
    this.uploadFiles.set(id, diskPath);

    // The uploader can type over whichever of title/artist they want (e.g.
    // pulled from the mp3's ID3 tags client-side); anything left blank
    // falls back to guessing from the filename, same as before.
    const guessed = titleFromFilename(name);
    const artist = overrides?.artist?.trim() || guessed.artist;
    const title = overrides?.title?.trim() || guessed.title;
    const item: QueueItem = {
      id,
      videoId: "",
      url: "",
      artist,
      title,
      addedBy,
      addedAt: Date.now(),
      source: "upload",
      libraryId,
      saveForLater,
      diskPath,
    };
    this.queue.push(item);
    this.start();

    if (saveForLater) {
      registerUpload({ libraryId, source: "upload", videoId: "", url: "", artist, title, addedBy });
      try {
        await mkdir(SAVED_UPLOADS_DIR, { recursive: true });
        const savedPath = path.join(SAVED_UPLOADS_DIR, `${libraryId.replace(/[^a-zA-Z0-9_-]/g, "")}.mp3`);
        await writeFile(savedPath, bytes);
        attachSavedUpload(libraryId, savedPath, Date.now() + SAVED_UPLOAD_TTL_MS);
      } catch (err) {
        console.error(`[workfm-queue] failed to save upload "${title}" for later:`, err);
      }
    }

    return item;
  }

  /**
   * Reconstructs a queue entry from a library track and adds it to this
   * room's queue. For YouTube tracks this just points back at the same
   * video (always available — re-fetched via yt-dlp same as any fresh
   * request). For uploads it points straight at the shared saved file on
   * disk (see workfmLibrary.ts's listSavedUploads) — it's deliberately not
   * registered in `uploadFiles`, so cleanup after play never deletes the
   * shared/retained asset (only the retention sweep in workfmLibrary.ts does).
   */
  requeueFromLibrary(entry: LibraryTrack, addedBy: string): QueueItem {
    if (this.queue.length >= MAX_QUEUE_LENGTH) throw new Error("the queue is full — try again once it's shorter");

    if (entry.source === "youtube") {
      if (!entry.videoId || !entry.url) throw new Error("that track is no longer available");
      const item: QueueItem = {
        id: this.nextId++,
        videoId: entry.videoId,
        url: entry.url,
        artist: entry.artist,
        title: entry.title,
        addedBy,
        addedAt: Date.now(),
        source: "youtube",
        libraryId: entry.id,
      };
      this.queue.push(item);
      this.start();
      return item;
    }

    if (!entry.savedFilePath) throw new Error("that track is no longer available");
    const item: QueueItem = {
      id: this.nextId++,
      videoId: "",
      url: "",
      artist: entry.artist,
      title: entry.title,
      addedBy,
      addedAt: Date.now(),
      source: "upload",
      libraryId: entry.id,
      saveForLater: true, // keep it saved — requeuing shouldn't shorten its retention
      diskPath: entry.savedFilePath,
    };
    this.queue.push(item);
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
      console.error(`[workfm-queue] failed to delete uploaded file ${filePath}:`, err);
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
   * Votes to skip the currently playing track — skipped as soon as votes
   * reach a majority of currently-present listeners, or an exact 50/50
   * split, since a tie means at least half the room wants it gone.
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

    // Toggle: voting again removes your vote, in case you change your mind.
    if (this.skipVotes.has(name)) this.skipVotes.delete(name);
    else this.skipVotes.add(name);

    const total = Math.max(this.listenerNames().length, 1);
    const votes = this.skipVotes.size;
    if (votes * 2 >= total) {
      this.skipVotes.clear();
      this.killPlayback();
      return { ok: true, skipped: true };
    }
    return { ok: true, skipped: false, votes, total, hasVoted: this.skipVotes.has(name) };
  }

  /**
   * Votes to repeat the currently playing track — unlike skip, this can't
   * take effect immediately (there's nothing to interrupt), so it just arms
   * a flag that loop() checks once the track finishes naturally: if armed,
   * the same item is reinserted at the front of the queue instead of moving
   * on, so it plays again right away rather than being requeued behind
   * whatever else gets added. It arms once votes reach a majority of
   * currently-present listeners (or an exact 50/50 split). Armed/voted
   * state resets whenever the track changes (see loop()).
   */
  requestRepeat(requestedBy: string): {
    ok: boolean;
    error?: string;
    armed?: boolean;
    votes?: number;
    total?: number;
    hasVoted?: boolean;
  } {
    if (!this.current) return { ok: false, error: "nothing is playing" };
    const name = requestedBy.toLowerCase();

    // Toggle: voting again removes your vote, in case you change your mind.
    if (this.repeatVotes.has(name)) this.repeatVotes.delete(name);
    else this.repeatVotes.add(name);

    const total = Math.max(this.listenerNames().length, 1);
    const votes = this.repeatVotes.size;
    this.repeatArmed = votes * 2 >= total;
    return { ok: true, armed: this.repeatArmed, votes, total, hasVoted: this.repeatVotes.has(name) };
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

  private async loop() {
    while (true) {
      if (this.queue.length === 0) {
        this.current = null;
        this.currentMetaString = "Radio Bækgaard - waiting for requests";
        const gen = ++this.currentGen;
        try {
          await this.playSilence(gen);
        } catch (err) {
          console.error("[workfm-queue] silence generator failed:", err);
        }
        continue;
      }
      const item = this.queue.shift()!;
      this.current = item;
      this.currentMetaString = `${item.artist} - ${item.title}`;
      this.skipVotes.clear();
      this.repeatVotes.clear();
      this.repeatArmed = false;
      recordPlay({
        libraryId: item.libraryId,
        source: item.source,
        videoId: item.videoId,
        url: item.url,
        artist: item.artist,
        title: item.title,
        addedBy: item.addedBy,
      });
      const gen = ++this.currentGen;
      let playedFully = false;
      try {
        await this.playEntry(item, gen);
        playedFully = this.currentGen === gen; // false if killPlayback() (skip) fired mid-track
      } catch (err) {
        console.error(`[workfm-queue] failed to play ${item.source === "upload" ? item.title : item.url}:`, err);
      }
      if (playedFully && this.repeatArmed) {
        // Reinsert the same item at the front so it plays again right away,
        // instead of being requeued behind whatever else has been added —
        // and skip the upload cleanup below since we still need the file.
        this.queue.unshift(item);
      } else if (item.source === "upload") {
        // The room's own temp copy is always cleaned up once played — if
        // saveForLater was set, a persistent copy was already written to
        // workfmLibrary's saved-uploads store at upload time (see
        // addUploadToQueue), so nothing else needs to happen here.
        this.cleanupUpload(item.id).catch(() => {});
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
    const filePath = entry.diskPath;
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

  /**
   * Streams silence to subscribers whenever the queue is empty, so
   * connections — including cliamp and other native clients, which have no
   * way to auto-reconnect — stay open instead of the stream going dead and
   * forcing a manual rejoin once a new track is added. Exits (and its
   * ffmpeg process is killed) the moment something's queued.
   */
  private async playSilence(gen: number): Promise<void> {
    const ffmpeg = Bun.spawn(
      ["ffmpeg", "-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", ...AUDIO_ARGS, "pipe:1"],
      { stdout: "pipe", stderr: "pipe" }
    );
    this.ytdlpProc = null;
    this.ffmpegProc = ffmpeg;

    try {
      const reader = ffmpeg.stdout.getReader();
      while (true) {
        if (this.currentGen !== gen || this.queue.length > 0) return; // a track's been queued
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) this.broadcast(value);
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

  /**
   * Fully tears down this room: stops any in-flight playback and deletes
   * any uploaded-but-not-yet-played files. Only called once a room's been
   * empty long enough to be auto-removed (see workfmRooms.ts) — there are no
   * subscribers left to disturb by definition.
   */
  async destroy() {
    this.stop();
    for (const id of [...this.uploadFiles.keys()]) {
      await this.cleanupUpload(id);
    }
    this.queue = [];
  }
}

export { WorkFmQueueStream };
