import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { relayPaced } from "./audioRelay";
import { attachSavedUpload, getLibraryTrack, listMostLiked, listMostPlayed, listPlayableHistoryIds, recordPlay, registerUpload, SAVED_UPLOAD_TTL_MS, SAVED_UPLOADS_DIR, type LibraryTrack } from "./workfmLibrary";
import { drainText, extractYouTubeVideoId, parseArtistTitle, YTDLP_COOKIE_ARGS, YTDLP_EXTRA_ARGS } from "./youtube";
import {
  announcementFilePath,
  listAnnouncementFiles,
  pickRandomAnnouncementFiles,
  type AnnouncementCategory,
  type AnnouncementFile,
} from "./workfmAnnouncements";

// ---------------------------------------------------------------------------
// WorkFM: an always-on radio queue engine with two queues layered on top of
// each other. The visible one is a live, public *request* queue — anyone can
// add a YouTube video or upload an mp3 (after picking a display name — see
// workfmIdentity.ts); requests play back-to-back in the order they were
// added (FIFO, no shuffling). Underneath it, an invisible "auto-DJ" queue
// keeps the station going whenever the request queue is empty: it shuffles
// through every track that's ever actually been played (see
// listPlayableHistoryIds() in workfmLibrary.ts) and plays them on repeat,
// forever, so there's always *something* on air — like a real radio station
// between requests. Auto-DJ picks are never inserted into (or visible via)
// the public queue; they're pulled fresh right as the request queue runs dry
// (see loop() below) and only ever exist as `this.current` while playing.
// Every track, whichever queue it came from, is broadcast to every listener
// at the same playback position, the same way playlistStream.ts does for the
// fixed-playlist stations. If there's truly nothing playable yet (empty
// history and empty request queue), the stream keeps broadcasting encoded
// silence (see playSilence() below) rather than going dead — the HTTP
// connection stays open and bytes keep flowing, so a listener already tuned
// in hears the next track the instant it's added, with no need to
// reconnect. That said, if the room's been completely empty (no stream
// subscribers, nobody with the page open — see emptySince) for
// AUTO_DJ_IDLE_TIMEOUT_MS, the auto-DJ stops picking new tracks and the
// loop goes to sleep (see sleepUntilNotIdle() below) rather than burning
// CPU forever transcoding to nobody; it wakes back up the instant a real
// request lands or someone shows up again. (Whole *rooms* — see
// workfmRooms.ts, which each own one WorkFmQueueStream instance — do get
// torn down after being empty a while.)
// ---------------------------------------------------------------------------

export const ICY_METAINT = 16000; // bytes of audio between each ICY metadata block
const AUDIO_ARGS = ["-ar", "44100", "-ac", "2", "-b:a", "128k", "-f", "mp3"];
const AUDIO_BYTES_PER_SEC = 16000; // 128kbps ÷ 8 — matches AUDIO_ARGS's bitrate, used to pace relayPaced()
const PREBUFFER_BYTES = AUDIO_BYTES_PER_SEC * 2; // ~2s buffered ahead before a track starts playing out
const MAX_QUEUE_LENGTH = 200; // sane upper bound so the queue can't be spammed into unbounded memory
const UPLOADS_DIR = path.join(import.meta.dir, "..", "data", "workfm-uploads");
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024; // 30MB — generous for an mp3, bounded so uploads can't fill the disk
const MAX_CHAT_MESSAGES = 100; // per room — oldest messages roll off once exceeded
const MAX_CHAT_MESSAGE_LENGTH = 500;
// Where the queue + chat are persisted to disk so an in-progress room
// survives a server restart (e.g. from an update — see scripts/update.sh)
// instead of coming back empty. See restore()/schedulePersist()/flush() below.
const QUEUE_STATE_PATH = path.join(import.meta.dir, "..", "data", "workfm-queue-state.json");
// How long a named visitor is considered "in the room" after their last
// GET /queue poll (see touchPresence()/list() below) before they're
// considered gone — comfortably longer than the client's ~1.5s poll
// interval so a slow network blip doesn't make someone flicker in and out.
const PRESENCE_TIMEOUT_MS = 10 * 1000;
// How long the room can go with nobody around at all (see emptySince
// getter) before the auto-DJ stops picking new tracks and the loop goes to
// sleep — no yt-dlp/ffmpeg processes running — to save CPU on the host.
// Real requests and actual listeners still wake it right back up (see
// sleepUntilNotIdle() below), so this only ever pauses the "always
// something on air" behavior, it doesn't tear anything down permanently.
const AUTO_DJ_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
// How often the idle sleep loop checks whether someone's shown up again.
const IDLE_POLL_INTERVAL_MS = 3 * 1000;
// How often (in ms of *actual playback time* — see msSincePlayClockStart())
// an announcement plays solo, and an ad break (at least AD_BREAK_MIN_DURATION_MS
// worth of ads, always capped off with an announcement) plays back-to-back —
// both inserted right after the currently playing track finishes naturally
// (see loop()'s maybeInsertSpecials()). Deliberately measured against
// playback time rather than wall-clock time, so a room that's been asleep
// (see sleepUntilNotIdle()) doesn't come back owing a pile of "overdue"
// announcements/ads.
const ANNOUNCEMENT_INTERVAL_MS = 30 * 60 * 1000;
const AD_BREAK_INTERVAL_MS = 60 * 60 * 1000;
// An ad break keeps adding random ads (repeats allowed once the pool's
// exhausted) until their combined duration reaches this — so picking one
// short ad doesn't end the break in a couple of seconds. Always finishes
// with one announcement before the music resumes (see maybeInsertSpecials()
// and pickAdBreakEntries()).
const AD_BREAK_MIN_DURATION_MS = 45 * 1000;
// Safety cap on how many ads a single break can pick, in case the pool is
// full of very short (or unprobeable-duration) files — keeps
// pickAdBreakEntries() from looping indefinitely.
const AD_BREAK_MAX_FILES = 30;
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
  /** Total track length in seconds, if known — fetched from yt-dlp/ffprobe
   * at add time (see addToQueue/addUploadToQueue) or, failing that,
   * best-effort probed right before it starts playing (see loop()). */
  durationSec?: number;
  /** Set when this item was picked by the auto-DJ (see pickAutoDjEntry()/
   * buildAutoDjItem() below) rather than actually requested by a listener —
   * such items never sit in the visible request queue, only ever exist as
   * `this.current` while playing. Left undefined for real requests. */
  isAutoDj?: boolean;
  /** Set when this is a scheduled announcement or ad-break "track" (see
   * workfmAnnouncements.ts + loop()'s maybeInsertSpecials()/playSpecial())
   * — an admin-uploaded mp3 played automatically between real tracks.
   * Never sits in the visible request queue, only ever exists as
   * `this.current` while playing. Un-repeatable always; announcements are
   * also unskippable, but an ad break CAN be majority-voted to skip (see
   * requestSkip/requestRepeat) — rendered without a progress bar or
   * requested-by/like/repeat-vote controls client-side (see WorkFm.tsx),
   * just the fixed "ANNOUNCEMENT"/"ADVERTISEMENT" label in `title` (plus a
   * skip-vote button for ads).
   */
  special?: AnnouncementCategory;
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

/** Fetches {title, uploader, durationSec} for a single YouTube video via yt-dlp. */
async function fetchVideoInfo(url: string): Promise<{ title: string; uploader: string | null; durationSec?: number }> {
  const proc = Bun.spawn(
    [
      "yt-dlp",
      ...YTDLP_COOKIE_ARGS,
      ...YTDLP_EXTRA_ARGS,
      "--no-playlist",
      "--skip-download",
      "--print",
      "%(title)s\t%(uploader)s\t%(duration)s",
      url,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [text, stderr] = await Promise.all([new Response(proc.stdout).text(), drainText(proc.stderr)]);
  const exitCode = await proc.exited;
  const [rawTitle, uploader, rawDuration] = text.split("\n")[0]?.split("\t") ?? [];
  if (exitCode !== 0 || !rawTitle) {
    const err = stderr.trim();
    throw new Error(err ? `couldn't look up that video: ${err}` : "couldn't look up that video");
  }
  const durationSec = Number.parseFloat(rawDuration ?? "");
  return {
    title: rawTitle.trim(),
    uploader: uploader?.trim() || null,
    durationSec: Number.isFinite(durationSec) ? Math.round(durationSec) : undefined,
  };
}

/** Best-effort track length (seconds) for a YouTube URL, used as a fallback
 * when a queue item somehow reached play-time without one (see loop()). */
async function probeUrlDurationSec(url: string): Promise<number | undefined> {
  try {
    const proc = Bun.spawn(
      ["yt-dlp", ...YTDLP_COOKIE_ARGS, ...YTDLP_EXTRA_ARGS, "--no-playlist", "--skip-download", "--print", "%(duration)s", url],
      { stdout: "pipe", stderr: "pipe" }
    );
    const text = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return undefined;
    const sec = Number.parseFloat(text.split("\n")[0] ?? "");
    return Number.isFinite(sec) ? Math.round(sec) : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort track length (seconds) for a local audio file via ffprobe. */
async function probeFileDurationSec(filePath: string): Promise<number | undefined> {
  try {
    const proc = Bun.spawn(
      ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
      { stdout: "pipe", stderr: "pipe" }
    );
    const text = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return undefined;
    const sec = Number.parseFloat(text.trim());
    return Number.isFinite(sec) ? Math.round(sec) : undefined;
  } catch {
    return undefined;
  }
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
  // When the current track started playing (ms since epoch, Date.now()) —
  // paired with current.durationSec so clients can render an "elapsed / total"
  // indicator without a server round-trip per second. Null whenever nothing's
  // playing (silence). Reset every time a new track (or a repeat) starts.
  private currentStartedAt: number | null = null;
  private currentMetaString = "";
  private started = false;
  private currentGen = 0;
  private nextId = 1;
  private ytdlpProc: ReturnType<typeof Bun.spawn> | null = null;
  private ffmpegProc: ReturnType<typeof Bun.spawn> | null = null;
  private skipVotes = new Set<string>(); // names who voted to skip the current track
  private repeatVotes = new Set<string>(); // names who voted to repeat the current track
  private repeatArmed = false; // whether the current track will replay itself once it finishes
  private nextVotes = new Map<number, Set<string>>(); // queue item id -> names who voted to bump it to the front
  private uploadFiles = new Map<number, string>(); // queue item id -> on-disk path, for uploaded mp3s
  private chat: ChatMessage[] = [];
  private nextChatId = 1;
  // Shuffled order (library ids) the auto-DJ works through whenever the
  // request queue is empty — reshuffled from scratch (see
  // listPlayableHistoryIds()) once exhausted. See pickAutoDjEntry() below.
  private autoDjShuffle: string[] = [];
  // libraryId of the last track the auto-DJ played, so a fresh reshuffle can
  // avoid immediately repeating it back-to-back.
  private lastAutoDjLibraryId: string | null = null;
  // name -> last time (ms since epoch) they polled GET /queue for this room.
  // This is how "who's in the room" is tracked — separate from who's
  // actually streaming audio (subscribers) — see touchPresence()/members().
  private presence = new Map<string, number>();
  // Timestamp since this room has had nobody around at all (no audio-stream
  // subscribers AND nobody polling the page — see emptySince getter below),
  // or null while someone's present. Starts "empty" at construction —
  // workfmRooms.ts uses this to auto-remove rooms nobody's actually using.
  private _emptySince: number | null = Date.now();
  // --- Announcement/ad scheduling clock ---
  // Accumulated ms of actual playback activity, paused whenever the room's
  // asleep (see sleepUntilNotIdle()) — see msSincePlayClockStart() below.
  private accumulatedPlayMs = 0;
  // Date.now() the clock was last (re)started, or null while paused.
  private playClockResumedAt: number | null = null;
  // msSincePlayClockStart() value the last time an announcement/ad break
  // played — compared against ANNOUNCEMENT_INTERVAL_MS/AD_BREAK_INTERVAL_MS
  // in loop()'s maybeInsertSpecials().
  private lastAnnouncementAtMs = 0;
  private lastAdBreakAtMs = 0;
  // Set by sleepUntilNotIdle() when the auto-DJ was fully resting (nothing
  // playing, nobody around) and someone shows up again — checked at the top
  // of loop() so the very next thing anyone hears is a welcome announcement,
  // before any song resumes. See maybePlayWelcomeAnnouncement().
  private pendingWelcomeAnnouncement = false;
  // Set by the admin dashboard's "Force ad"/"Force announcement" test
  // buttons (see forceAdBreak()/forceAnnouncement() below) — checked ahead
  // of the normal timer in maybeInsertSpecials() so the very next track
  // boundary plays one immediately, without waiting for the real interval.
  private forcedAdBreak = false;
  private forcedAnnouncement = false;

  /** Total ms of actual playback activity since this room was created,
   * excluding any stretches spent asleep (idle, no listeners — see
   * sleepUntilNotIdle()). This is the clock ANNOUNCEMENT_INTERVAL_MS/
   * AD_BREAK_INTERVAL_MS are measured against. */
  private msSincePlayClockStart(): number {
    return this.accumulatedPlayMs + (this.playClockResumedAt !== null ? Date.now() - this.playClockResumedAt : 0);
  }

  private pausePlayClock() {
    if (this.playClockResumedAt !== null) {
      this.accumulatedPlayMs += Date.now() - this.playClockResumedAt;
      this.playClockResumedAt = null;
    }
  }

  private resumePlayClock() {
    if (this.playClockResumedAt === null) this.playClockResumedAt = Date.now();
  }

  get status() {
    return {
      running: this.current !== null,
      listeners: this.subscribers.size,
      members: this.activeMemberNames().length,
      nowPlaying: this.current
        ? {
            id: this.current.id,
            artist: this.current.artist,
            title: this.current.title,
            addedBy: this.current.addedBy,
            durationSec: this.current.durationSec,
            startedAt: this.currentStartedAt,
          }
        : null,
      // Defensive filter — auto-DJ picks are shifted out of `this.queue`
      // synchronously the instant they're pushed (see loop()), so this
      // should never actually find one, but the request queue's length
      // should never count them even if that ever changes.
      queueLength: this.queue.filter((i) => !i.isAutoDj).length,
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

  /** Attaches this queued item's "vote next" tally — same majority-of-
   * present-members mechanic as requestMoveToFront below, but tracked per
   * queue item id instead of "the current track" since any not-yet-played
   * entry can be voted on independently. Majority is of everyone currently
   * present in the room (activeMemberNames), not just people actively
   * streaming the audio (listenerNames) — voting doesn't require tuning in,
   * so a vote total shouldn't shrink to just those who are. */
  private withNextVote(item: QueueItem, viewerName?: string): { votes: number; total: number; hasVoted: boolean } {
    const voters = this.nextVotes.get(item.id);
    const name = viewerName?.toLowerCase();
    return {
      votes: voters?.size ?? 0,
      total: Math.max(this.activeMemberNames().length, 1),
      hasVoted: !!name && !!voters?.has(name),
    };
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

  /** Top 5 (by play count) songs across *every* WorkFM room — same global
   * library view as roomLeaderboard, just sorted by how many times a track
   * has actually played rather than its like count. */
  private roomMostPlayed(
    viewerName: string | undefined,
    limit = 5
  ): {
    libraryId: string;
    title: string;
    artist: string;
    playCount: number;
    addedBy: string;
    available: boolean;
  }[] {
    return listMostPlayed(viewerName, limit).map((e) => ({
      libraryId: e.id,
      title: e.title,
      artist: e.artist,
      playCount: e.playCount,
      addedBy: e.addedBy,
      available: e.available,
    }));
  }

  list(viewerName?: string): {
    nowPlaying: (QueueItem & { likes: number; likedByMe: boolean; startedAt: number | null }) | null;
    queue: (QueueItem & { likes: number; likedByMe: boolean; nextVote: { votes: number; total: number; hasVoted: boolean } })[];
    listeners: string[];
    anonymousListeners: number;
    members: { name: string; listening: boolean }[];
    leaderboard: ReturnType<WorkFmQueueStream["roomLeaderboard"]>;
    mostPlayed: ReturnType<WorkFmQueueStream["roomMostPlayed"]>;
    skipVote: { votes: number; total: number; hasVoted: boolean };
    repeatVote: { armed: boolean; votes: number; total: number; hasVoted: boolean };
    chat: ChatMessage[];
  } {
    this.touchPresence(viewerName);
    const listeners = this.listenerNames();
    const listening = new Set(listeners);
    const activeMembers = this.activeMemberNames();
    const members = activeMembers.map((name) => ({ name, listening: listening.has(name) }));
    return {
      nowPlaying: this.current ? { ...this.withLikes(this.current, viewerName), startedAt: this.currentStartedAt } : null,
      // Same defensive filter as status's queueLength above — auto-DJ picks
      // should never actually be visible here, but are excluded on
      // principle rather than relying purely on the timing guarantee.
      queue: this.queue
        .filter((item) => !item.isAutoDj)
        .map((item) => ({ ...this.withLikes(item, viewerName), nextVote: this.withNextVote(item, viewerName) })),
      listeners,
      anonymousListeners: this.anonymousListenerCount(),
      members,
      leaderboard: this.roomLeaderboard(viewerName),
      mostPlayed: this.roomMostPlayed(viewerName),
      skipVote: {
        votes: this.skipVotes.size,
        // Majority of everyone present (activeMembers), matching
        // requestSkip's own threshold — not just people streaming audio.
        total: Math.max(activeMembers.length, 1),
        hasVoted: !!viewerName && this.skipVotes.has(viewerName.toLowerCase()),
      },
      repeatVote: {
        armed: this.repeatArmed,
        votes: this.repeatVotes.size,
        total: Math.max(activeMembers.length, 1),
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
    this.resumePlayClock();
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
      durationSec: info.durationSec,
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
    const durationSec = await probeFileDurationSec(diskPath);

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
      durationSec,
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
    this.nextVotes.delete(id);
    return { ok: true };
  }

  /**
   * Votes to bump a queued (not-yet-playing) track to the front of the
   * queue — same majority-of-present-members toggle mechanic as
   * requestSkip/requestRepeat, but tracked per queue item id so any entry
   * can be voted on independently of the others. Reaching a majority moves
   * it to the front immediately and clears its votes (a fresh vote is
   * needed to bump it again from wherever it ends up next).
   */
  requestMoveToFront(
    itemId: number,
    requestedBy: string
  ): {
    ok: boolean;
    error?: string;
    moved?: boolean;
    votes?: number;
    total?: number;
    hasVoted?: boolean;
  } {
    const idx = this.queue.findIndex((q) => q.id === itemId);
    if (idx === -1) return { ok: false, error: "not found (maybe it's already playing or was removed)" };
    if (idx === 0) return { ok: false, error: "that track is already next" };
    const name = requestedBy.toLowerCase();

    let voters = this.nextVotes.get(itemId);
    if (!voters) {
      voters = new Set();
      this.nextVotes.set(itemId, voters);
    }
    // Toggle: voting again removes your vote, in case you change your mind.
    if (voters.has(name)) voters.delete(name);
    else voters.add(name);

    // Majority of everyone currently present in the room (activeMemberNames),
    // not just people actively streaming the audio (listenerNames) — voting
    // doesn't require tuning in, so a lone listener shouldn't be able to hit
    // "100%" of an artificially tiny total while other members present go
    // uncounted.
    const total = Math.max(this.activeMemberNames().length, 1);
    const votes = voters.size;
    if (votes * 2 >= total) {
      this.nextVotes.delete(itemId);
      const [moved] = this.queue.splice(idx, 1);
      if (moved) this.queue.unshift(moved);
      return { ok: true, moved: true };
    }
    return { ok: true, moved: false, votes, total, hasVoted: voters.has(name) };
  }

  /**
   * Votes to skip the currently playing track — skipped as soon as votes
   * reach a majority of currently-present members, or an exact 50/50
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
    // Announcements are always unskippable; ad breaks are the one exception
    // (see playSpecial()'s per-entry gen check, which ends the whole break
    // — not just the currently airing file — once this succeeds).
    if (this.current.special === "announcement") return { ok: false, error: "this can't be skipped" };
    const name = requestedBy.toLowerCase();

    // Toggle: voting again removes your vote, in case you change your mind.
    if (this.skipVotes.has(name)) this.skipVotes.delete(name);
    else this.skipVotes.add(name);

    // See requestMoveToFront's comment above for why this is
    // activeMemberNames() rather than listenerNames().
    const total = Math.max(this.activeMemberNames().length, 1);
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
   * currently-present members (or an exact 50/50 split). Armed/voted
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
    if (this.current.special) return { ok: false, error: "this can't be repeated" };
    const name = requestedBy.toLowerCase();

    // Toggle: voting again removes your vote, in case you change your mind.
    if (this.repeatVotes.has(name)) this.repeatVotes.delete(name);
    else this.repeatVotes.add(name);

    // See requestMoveToFront's comment above for why this is
    // activeMemberNames() rather than listenerNames().
    const total = Math.max(this.activeMemberNames().length, 1);
    const votes = this.repeatVotes.size;
    this.repeatArmed = votes * 2 >= total;
    return { ok: true, armed: this.repeatArmed, votes, total, hasVoted: this.repeatVotes.has(name) };
  }

  /**
   * Admin test hooks (Dashboard's "Force ad"/"Force announcement" buttons):
   * flags the respective special to play at the very next track boundary,
   * regardless of the real timer — so an admin can verify the feature
   * without waiting up to an hour/30 minutes. A no-op if one's already
   * pending (repeated clicks don't queue up multiple).
   */
  forceAdBreak(): void {
    this.forcedAdBreak = true;
  }

  forceAnnouncement(): void {
    this.forcedAnnouncement = true;
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

  /**
   * Picks the next track for the auto-DJ to play — a library entry from
   * history, shuffled — or null if there's nothing playable yet (fresh
   * install with no history, or every saved upload has expired since being
   * shuffled in). Refills+reshuffles `autoDjShuffle` from
   * listPlayableHistoryIds() once it runs out, swapping the last-played
   * track out of the first slot (if it landed there) so shuffle repeats
   * don't play the same thing twice in a row.
   */
  private pickAutoDjEntry(): LibraryTrack | null {
    if (this.autoDjShuffle.length === 0) {
      const ids = listPlayableHistoryIds();
      if (ids.length === 0) return null;
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j]!, ids[i]!];
      }
      if (ids.length > 1 && ids[0] === this.lastAutoDjLibraryId) {
        [ids[0], ids[1]] = [ids[1]!, ids[0]!];
      }
      this.autoDjShuffle = ids;
    }
    // Entries can have gone stale (e.g. a saved upload's TTL expired) since
    // they were shuffled in — re-fetch and skip any that are no longer
    // playable rather than surfacing a broken track.
    while (this.autoDjShuffle.length > 0) {
      const id = this.autoDjShuffle.shift()!;
      const entry = getLibraryTrack(id);
      const playable = entry && (entry.source === "youtube" ? !!entry.videoId && !!entry.url : !!entry.savedFilePath);
      if (entry && playable) {
        this.lastAutoDjLibraryId = id;
        return entry;
      }
    }
    return null;
  }

  /** Turns an auto-DJ's picked library entry into a playable (but
   * invisible — see QueueItem.isAutoDj) queue item, mirroring
   * requeueFromLibrary()'s reconstruction logic. */
  private buildAutoDjItem(entry: LibraryTrack): QueueItem | null {
    const base = {
      id: this.nextId++,
      addedBy: "Auto DJ",
      addedAt: Date.now(),
      libraryId: entry.id,
      isAutoDj: true as const,
    };
    if (entry.source === "youtube") {
      if (!entry.videoId || !entry.url) return null;
      return { ...base, videoId: entry.videoId, url: entry.url, artist: entry.artist, title: entry.title, source: "youtube" };
    }
    if (!entry.savedFilePath) return null;
    return {
      ...base,
      videoId: "",
      url: "",
      artist: entry.artist,
      title: entry.title,
      source: "upload",
      diskPath: entry.savedFilePath,
      saveForLater: true, // it's the shared saved copy — never delete it after play
    };
  }

  /**
   * Pauses the auto-DJ once the room's been empty (see emptySince) for
   * AUTO_DJ_IDLE_TIMEOUT_MS — no track picked, no ffmpeg/yt-dlp spawned,
   * nothing broadcast — and blocks until either a real request lands in
   * the queue or someone shows up again (a stream subscriber connects, or
   * a page poll touches presence), at which point the loop resumes as
   * normal. This only runs when the room was already idle long enough, so
   * it never delays picking up a request from someone who's actually here.
   */
  private async sleepUntilNotIdle(gen: number): Promise<void> {
    this.current = null;
    this.currentStartedAt = null;
    this.currentMetaString = "Radio Bækgaard - auto-DJ resting (no listeners)";
    this.pausePlayClock();
    while (this.currentGen === gen && this.queue.length === 0 && this.emptySince !== null) {
      await Bun.sleep(IDLE_POLL_INTERVAL_MS);
    }
    this.resumePlayClock();
    if (this.currentGen === gen) this.pendingWelcomeAnnouncement = true;
  }

  /**
   * Plays one random announcement before anything else, if the auto-DJ just
   * woke up from being fully idle (see sleepUntilNotIdle()) — so someone
   * joining an empty room hears an announcement first instead of dropping
   * straight into the middle of a song. A no-op once consumed, or if no
   * announcement files have been uploaded yet.
   */
  private async maybePlayWelcomeAnnouncement(): Promise<void> {
    if (!this.pendingWelcomeAnnouncement) return;
    this.pendingWelcomeAnnouncement = false;
    const entries = await pickRandomAnnouncementFiles("announcement", 1);
    if (entries.length > 0) await this.playSpecial("announcement", entries, "ANNOUNCEMENT");
  }

  private async loop() {
    while (true) {
      await this.maybePlayWelcomeAnnouncement();
      if (this.queue.length === 0) {
        const emptySince = this.emptySince;
        if (emptySince !== null && Date.now() - emptySince >= AUTO_DJ_IDLE_TIMEOUT_MS) {
          const gen = this.currentGen;
          await this.sleepUntilNotIdle(gen);
          continue;
        }
        // Request queue's empty — let the auto-DJ fill in with a shuffled
        // pick from history instead of going straight to silence. This
        // item is pushed and immediately shifted below with no `await` in
        // between, so it's never observable in the public queue (see
        // list()/status).
        const autoEntry = this.pickAutoDjEntry();
        const autoItem = autoEntry ? this.buildAutoDjItem(autoEntry) : null;
        if (autoItem) {
          this.queue.push(autoItem);
        } else {
          this.current = null;
          this.currentStartedAt = null;
          this.currentMetaString = "Radio Bækgaard - waiting for requests";
          const gen = ++this.currentGen;
          try {
            await this.playSilence(gen);
          } catch (err) {
            console.error("[workfm-queue] silence generator failed:", err);
          }
          continue;
        }
      }
      const item = this.queue.shift()!;
      this.current = item;
      this.currentMetaString = `${item.artist} - ${item.title}`;
      this.skipVotes.clear();
      this.repeatVotes.clear();
      this.repeatArmed = false;
      this.nextVotes.delete(item.id);
      // Fallback for the rare case a queue item reached play-time with no
      // known length (e.g. requeued from the library, which doesn't refetch
      // duration) — best-effort only, so the "elapsed / total" indicator
      // just omits the total if this fails too.
      if (item.durationSec == null) {
        item.durationSec = await (item.source === "upload"
          ? probeFileDurationSec(item.diskPath ?? "")
          : probeUrlDurationSec(item.url));
      }
      this.currentStartedAt = Date.now();
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
      await this.maybeInsertSpecials();
    }
  }

  /**
   * Called at every real track boundary (right after one finishes, whether
   * played fully or skipped) — inserts a scheduled ad break and/or
   * announcement if either is due (see ANNOUNCEMENT_INTERVAL_MS/
   * AD_BREAK_INTERVAL_MS). An ad break always finishes with one announcement
   * before returning to music (see pickAdBreakEntries()), which also
   * satisfies/resets the solo-announcement timer — so the standalone
   * announcement check below only ever fires when an ad break *didn't* just
   * play one. A no-op if no files have been uploaded for a due category yet
   * (see workfmAnnouncements.ts).
   */
  private async maybeInsertSpecials(): Promise<void> {
    if (this.forcedAdBreak || this.msSincePlayClockStart() - this.lastAdBreakAtMs >= AD_BREAK_INTERVAL_MS) {
      this.forcedAdBreak = false;
      this.lastAdBreakAtMs = this.msSincePlayClockStart();
      const ads = await this.pickAdBreakEntries();
      if (ads.length > 0) {
        await this.playSpecial("ad", ads, "ADVERTISEMENT");
        this.forcedAnnouncement = false;
        this.lastAnnouncementAtMs = this.msSincePlayClockStart();
        const announcement = await pickRandomAnnouncementFiles("announcement", 1);
        if (announcement.length > 0) await this.playSpecial("announcement", announcement, "ANNOUNCEMENT");
        return;
      }
    }
    if (this.forcedAnnouncement || this.msSincePlayClockStart() - this.lastAnnouncementAtMs >= ANNOUNCEMENT_INTERVAL_MS) {
      this.forcedAnnouncement = false;
      this.lastAnnouncementAtMs = this.msSincePlayClockStart();
      const entries = await pickRandomAnnouncementFiles("announcement", 1);
      if (entries.length > 0) await this.playSpecial("announcement", entries, "ANNOUNCEMENT");
    }
  }

  /**
   * Picks the ads for a single ad break: keeps adding random picks (repeats
   * allowed once the pool's been exhausted once) until their combined
   * duration reaches AD_BREAK_MIN_DURATION_MS, so a short first pick doesn't
   * end the break in a couple of seconds — bounded by AD_BREAK_MAX_FILES in
   * case the pool is full of very short/unprobeable-duration files. Returns
   * [] if there are no ad files uploaded at all yet.
   */
  private async pickAdBreakEntries(): Promise<AnnouncementFile[]> {
    const pool = await listAnnouncementFiles("ad");
    if (pool.length === 0) return [];
    const picked: AnnouncementFile[] = [];
    let totalMs = 0;
    while (totalMs < AD_BREAK_MIN_DURATION_MS && picked.length < AD_BREAK_MAX_FILES) {
      const entry = pool[Math.floor(Math.random() * pool.length)]!;
      picked.push(entry);
      const durationSec = await probeFileDurationSec(announcementFilePath(entry));
      // Unknown duration (probe failed): assume a conservative 15s rather
      // than looping forever or risking a too-short break.
      totalMs += (durationSec ?? 15) * 1000;
    }
    return picked;
  }

  /**
   * Plays one or more admin-uploaded mp3 files back-to-back as a single
   * "special" broadcast segment (an announcement or an ad break) — shown to
   * listeners as `label` instead of a real track/artist, with no progress
   * bar or requested-by/like/repeat-vote controls (see QueueItem.special +
   * WorkFm.tsx). Un-repeatable always; announcements are also unskippable,
   * but a majority skip vote (see requestSkip()) during an ad ends the
   * *entire* remaining break — not just the currently airing file — via the
   * currentGen check below, the same mechanism a real track's skip uses.
   * Resets any stale skip votes at the start of each segment. Reuses
   * playUpload() for the actual local-file playback, same as any other
   * uploaded mp3.
   */
  private async playSpecial(category: AnnouncementCategory, entries: AnnouncementFile[], label: string): Promise<void> {
    this.skipVotes.clear();
    for (const entry of entries) {
      const item: QueueItem = {
        id: this.nextId++,
        videoId: "",
        url: "",
        artist: "",
        title: label,
        addedBy: "Radio Bækgaard",
        addedAt: Date.now(),
        source: "upload",
        libraryId: `${category}:${entry.id}`,
        diskPath: announcementFilePath(entry),
        special: category,
      };
      this.current = item;
      this.currentMetaString = label;
      this.currentStartedAt = Date.now();
      const gen = ++this.currentGen;
      try {
        await this.playUpload(item, gen);
      } catch (err) {
        console.error(`[workfm-queue] failed to play ${category} "${entry.title}":`, err);
      }
      if (this.currentGen !== gen) break; // skip-voted mid-ad — end the whole break, not just this file
    }
    this.skipVotes.clear();
  }

  private async playEntry(entry: QueueItem, gen: number): Promise<void> {
    if (entry.source === "upload") return this.playUpload(entry, gen);

    const ytdlp = Bun.spawn(
      ["yt-dlp", ...YTDLP_COOKIE_ARGS, ...YTDLP_EXTRA_ARGS, "-f", "bestaudio/best", "--no-playlist", "--quiet", "--no-warnings", "-o", "-", entry.url],
      { stdout: "pipe", stderr: "pipe" }
    );
    // No `-re` here: pacing ffmpeg's *reads* off the piped yt-dlp download
    // ties its output timing to the network's, so any brief download stall
    // used to stutter the audible stream. ffmpeg instead transcodes flat
    // out, and relayPaced() below buffers+paces the actual real-time output
    // itself, which can absorb those stalls instead of passing them through.
    const ffmpeg = Bun.spawn(
      ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", ...AUDIO_ARGS, "pipe:1"],
      { stdin: ytdlp.stdout, stdout: "pipe", stderr: "pipe" }
    );
    this.ytdlpProc = ytdlp;
    this.ffmpegProc = ffmpeg;

    const ytdlpStderr = drainText(ytdlp.stderr);
    const ffmpegStderr = drainText(ffmpeg.stderr);
    // Bridges the gap between "this track just started spinning up" and
    // "relayPaced() has prebuffered enough of it to start broadcasting" —
    // yt-dlp resolving/starting the download plus the ~2s prebuffer below
    // easily adds up to a few seconds of *nothing at all* being sent to
    // subscribers otherwise, which stalls players (heard as a stutter/gap
    // on every track change) and can even make some drop the connection
    // outright. Stopped the instant real audio starts flowing.
    const stopBridge = this.startBridgeSilence(gen);
    let firstChunk = true;

    try {
      const reader = ffmpeg.stdout.getReader();
      await relayPaced(
        reader,
        (chunk) => {
          if (firstChunk) {
            firstChunk = false;
            stopBridge();
          }
          this.broadcast(chunk);
        },
        () => this.currentGen !== gen,
        AUDIO_BYTES_PER_SEC,
        PREBUFFER_BYTES
      );
      if (this.currentGen !== gen) return; // skipped mid-track
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
      stopBridge();
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
    // Uploads start playing back much faster than a YouTube fetch (no
    // network download to wait on), but ffmpeg's own process startup is
    // still a small gap worth bridging for consistency.
    const stopBridge = this.startBridgeSilence(gen);
    let firstChunk = true;

    try {
      const reader = ffmpeg.stdout.getReader();
      while (true) {
        if (this.currentGen !== gen) return; // skipped mid-track
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          if (firstChunk) {
            firstChunk = false;
            stopBridge();
          }
          this.broadcast(value);
        }
      }
      const ffExit = await ffmpeg.exited;
      if (ffExit !== 0 && this.currentGen === gen) {
        const ffErr = (await ffmpegStderr).trim();
        throw new Error(`ffmpeg exited with code ${ffExit}` + (ffErr ? `\nffmpeg stderr: ${ffErr}` : ""));
      }
    } finally {
      stopBridge();
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

  /**
   * Starts a short-lived, genuinely mp3-encoded silence broadcast (same
   * `anullsrc` trick as playSilence) that runs in the background until
   * stopped — used by playEntry/playUpload to bridge the gap between a
   * track starting to load and its first real audio chunk being ready,
   * instead of sending subscribers literally nothing for that window (see
   * callers for why that matters). Deliberately not tracked in
   * this.ytdlpProc/ffmpegProc: it self-terminates the instant `gen` is
   * superseded (e.g. a skip lands mid-bridge), so killPlayback() doesn't
   * need to know about it.
   */
  private startBridgeSilence(gen: number): () => void {
    let stopped = false;
    const ffmpeg = Bun.spawn(
      ["ffmpeg", "-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", ...AUDIO_ARGS, "pipe:1"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const kill = () => {
      try {
        ffmpeg.kill();
      } catch {
        // already exited
      }
    };
    (async () => {
      try {
        const reader = ffmpeg.stdout.getReader();
        while (!stopped && this.currentGen === gen) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length > 0) this.broadcast(value);
        }
      } catch {
        // best-effort filler — a failure here just means a slightly longer gap
      } finally {
        kill();
      }
    })();
    return () => {
      stopped = true;
      kill();
    };
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
