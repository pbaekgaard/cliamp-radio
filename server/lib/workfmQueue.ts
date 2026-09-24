import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { relayPaced } from "./audioRelay";
import { attachSavedUpload, attachYoutubeCache, getCachedYoutubeFile, getLibraryTrack, listMostLiked, listMostPlayed, listPlayableHistoryIds, recordPlay, registerUpload, SAVED_UPLOADS_DIR, YOUTUBE_CACHE_DIR, type LibraryTrack } from "./workfmLibrary";
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
// How much recent audio is kept around so a *newly connecting* listener can
// be handed a few seconds' worth all at once (as fast as their connection
// allows) instead of only ever receiving new bytes at the strict real-time
// broadcast pace — see subscribe()'s burst-on-connect below. Without this,
// every "Listen in" press has to wait out however many seconds of live
// real-time trickle the browser's own decode buffer wants before audio
// becomes audible, since the server otherwise never sends ahead of the
// live edge. This also gives fresh connections a cushion against brief
// network hiccups right after joining, which otherwise show up as an
// audible drop within the first few seconds.
const BACKLOG_BYTES = AUDIO_BYTES_PER_SEC * 4; // ~4s
// How many seconds two tracks overlap during a crossfaded transition (see
// scheduleLookahead()/runCrossfade() below) — only happens when the
// upcoming track's audio is already fully downloaded to disk by the time
// the current one is ending; otherwise playback falls back to the older
// silence-bridged hard cut.
const CROSSFADE_SEC = 3;
// relayPaced() bursts this out instantly (see audioRelay.ts) rather than
// dripping it out at bytesPerSec, so a *cold* start (nobody listening, so
// the auto-DJ was asleep and just spun a fresh ffmpeg up for the first
// joiner) gets an instant ~2s cushion instead of waiting out 2s of
// real-time trickle. Deliberately kept lower than BACKLOG_BYTES (rather
// than raised to match it) so already-connected listeners don't gain an
// extra silent gap at every track change — this only controls the one-time
// wait before a *newly started* track's first bytes go out at all.
const PREBUFFER_BYTES = AUDIO_BYTES_PER_SEC * 2;
const MAX_QUEUE_LENGTH = 200; // sane upper bound so the queue can't be spammed into unbounded memory
const UPLOADS_DIR = path.join(import.meta.dir, "..", "data", "workfm-uploads");
// Where tracks get downloaded ahead of time — during the spisetid pause
// window (see prefetchQueue()) so they start playing instantly the moment
// music resumes at 12:00, and generally right before a track boundary (see
// scheduleLookahead()) so it can be crossfaded into. Nothing in here is
// meaningful across a restart (each entry is tied to a live in-memory
// pick), so it's wiped clean at startup below rather than accumulating
// orphaned files from downloads interrupted mid-flight.
const PREFETCH_DIR = path.join(import.meta.dir, "..", "data", "workfm-prefetch");
rm(PREFETCH_DIR, { recursive: true, force: true }).catch(() => {});
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024; // 30MB — generous for an mp3, bounded so uploads can't fill the disk
const MAX_CHAT_MESSAGES = 100; // per room — oldest messages roll off once exceeded
const MAX_CHAT_MESSAGE_LENGTH = 500;
const CHAT_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000; // messages expire 24h after being sent
// Where chat history is persisted to disk so it survives a server restart
// (e.g. from an update — see scripts/update.sh) instead of resetting to
// empty every time. The request/auto-DJ queue itself is intentionally NOT
// persisted — it's tied to a live ffmpeg/yt-dlp process that a restart
// necessarily interrupts anyway, so there's nothing meaningful to resume —
// but chat is just plain data with no such dependency, so it can (and
// should) survive right through. See loadChatState()/saveChatState() below.
const CHAT_STATE_PATH = path.join(import.meta.dir, "..", "data", "workfm-chat-state.json");
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
// --- "Spisetid" (lunch break) — every weekday, 11:30–12:00 Danish time,
// Radio Bækgaard pauses for lunch: 11:30–11:40 an alarm sounds (interrupting
// whatever's currently playing, mid-track if need be), then 11:40–12:00 the
// stream stays paused/silent while the request queue gets prefetched (see
// prefetchQueue() below) so playback resumes instantly at 12:00. See
// enforceSpiseTidSchedule()/runSpiseTid() below for the actual mechanics,
// and workfmAnnouncements.ts's "spisetid" category for the admin-uploadable
// alarm sound(s) (falls back to a synthesized siren tone if none are set).
const SPISETID_TIMEZONE = "Europe/Copenhagen";
const SPISETID_START_MIN = 11 * 60 + 30; // 11:30
const SPISETID_ALARM_END_MIN = 11 * 60 + 40; // 11:40 — alarm plays 11:30–11:40
const SPISETID_END_MIN = 12 * 60; // 12:00 — back to normal
const SPISETID_ALARM_DURATION_MS = (SPISETID_ALARM_END_MIN - SPISETID_START_MIN) * 60 * 1000;
const SPISETID_TOTAL_DURATION_MS = (SPISETID_END_MIN - SPISETID_START_MIN) * 60 * 1000;
// How often the schedule is checked — frequent enough that the alarm
// interrupts a mid-track song within a couple seconds of 11:30 hitting,
// without being wasteful.
const SPISETID_CHECK_INTERVAL_MS = 2 * 1000;
type SpiseTidPhase = "alarm" | "pause";

/** What the *real, weekly-scheduled* spisetid phase is right now, purely a
 * function of the current Danish wall-clock time — Mon–Fri only. Doesn't
 * know about admin forcing/stopping (see WorkFmQueueStream's
 * computeSpiseTidPhase(), which layers that on top). */
function getScheduledSpiseTidPhase(): SpiseTidPhase | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SPISETID_TIMEZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  if (weekday === "Sat" || weekday === "Sun") return null;
  const hour = Number.parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = Number.parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const mins = hour * 60 + minute;
  if (mins >= SPISETID_START_MIN && mins < SPISETID_ALARM_END_MIN) return "alarm";
  if (mins >= SPISETID_ALARM_END_MIN && mins < SPISETID_END_MIN) return "pause";
  return null;
}

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
  // Rolling window of the most recent broadcast audio (raw, pre-ICY-framing
  // — each new subscriber gets it re-framed with its own bytesSinceMeta
  // count in subscribe() below), trimmed to BACKLOG_BYTES in broadcast().
  private backlogChunks: Uint8Array[] = [];
  private backlogBytes = 0;
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
  // Debounce flag for saveChatState() — mirrors workfmLibrary.ts's save()
  // pattern, so a burst of messages coalesces into one disk write instead
  // of one per message.
  private chatSaveQueued = false;
  // --- Spisetid (lunch break) state — see the SPISETID_* constants above
  // and enforceSpiseTidSchedule()/runSpiseTid() below for the mechanics. ---
  // Which sub-phase is active right now (null = not spisetid at all).
  // Recomputed every SPISETID_CHECK_INTERVAL_MS by enforceSpiseTidSchedule().
  private spiseTidPhase: SpiseTidPhase | null = null;
  // Set by the admin dashboard's "Force spisetid" test button — runs the
  // same alarm→pause→resume cycle as the real 11:30 schedule, just on its
  // own clock instead of Danish wall-clock time. Cleared automatically once
  // the forced cycle completes, or early by "Stop spisetid".
  private forcedSpiseTid: { alarmEndsAt: number; endsAt: number } | null = null;
  // Set by "Stop spisetid" to override the real schedule for a while, so
  // clicking Stop during the actual 11:30–12:00 window doesn't just have
  // the very next schedule check re-trigger it immediately.
  private suppressScheduledSpiseTidUntil: number | null = null;
  private spiseTidTimer: ReturnType<typeof setInterval> | null = null;
  // Guards prefetchQueue() so it only actually runs once per pause window.
  private spiseTidPrefetchDone = false;
  // queue item id -> on-disk path of its prefetched audio (see
  // prefetchQueue()/playEntry() below) — consumed (and deleted) the moment
  // that item starts playing, whether or not it was ever queued during the
  // pause window that downloaded it.
  private prefetchedFiles = new Map<number, string>();
  // A speculative auto-DJ pick, computed early (see peekAutoDjItem()) so
  // its audio can start downloading (scheduleLookahead()) while whatever's
  // currently playing still has time left — consumed by takeAutoDjItem()
  // once the request queue actually goes empty and it's genuinely this
  // pick's turn. Keeps pickAutoDjEntry()'s one-shot shuffle-consuming
  // semantics intact even though it's now sometimes called ahead of time.
  private pendingAutoDjPick: QueueItem | null = null;
  // ids currently being downloaded by scheduleLookahead(), so a track
  // playing for a long time doesn't kick off duplicate downloads of the
  // same upcoming item.
  private lookaheadInFlight = new Set<number>();

  constructor() {
    this.loadChatState();
    this.spiseTidTimer = setInterval(() => this.enforceSpiseTidSchedule(), SPISETID_CHECK_INTERVAL_MS);
  }

  /** Loads persisted chat history (see CHAT_STATE_PATH) at startup, so a
   * server restart — from an update or otherwise — doesn't wipe the room's
   * conversation. Missing/corrupt file just means a fresh, empty chat. */
  private loadChatState() {
    try {
      const raw = readFileSync(CHAT_STATE_PATH, "utf-8");
      const parsed = JSON.parse(raw) as { chat: ChatMessage[]; nextChatId: number };
      if (Array.isArray(parsed.chat)) this.chat = parsed.chat;
      if (typeof parsed.nextChatId === "number") this.nextChatId = parsed.nextChatId;
      this.pruneExpiredChat();
    } catch {
      // No saved state yet, or it's unreadable — start with empty chat.
    }
  }

  /** Drops any message older than CHAT_MESSAGE_TTL_MS — messages have a
   * fixed 24h lifetime regardless of how many have been sent since, same
   * idea as the MAX_CHAT_MESSAGES cap but time-based instead of count-based. */
  private pruneExpiredChat() {
    const cutoff = Date.now() - CHAT_MESSAGE_TTL_MS;
    const before = this.chat.length;
    if (before > 0 && this.chat[0]!.at >= cutoff) return; // fast path: oldest is still fresh
    this.chat = this.chat.filter((m) => m.at >= cutoff);
    if (this.chat.length !== before) this.saveChatState();
  }

  /** Debounced write of the current chat history to disk — called after
   * every new message so an update/restart never loses more than whatever
   * was in flight at the exact moment of the crash (practically nothing,
   * since this fires synchronously off the same event as the post). */
  private saveChatState() {
    if (this.chatSaveQueued) return;
    this.chatSaveQueued = true;
    queueMicrotask(async () => {
      this.chatSaveQueued = false;
      try {
        await mkdir(path.dirname(CHAT_STATE_PATH), { recursive: true });
        await writeFile(CHAT_STATE_PATH, JSON.stringify({ chat: this.chat, nextChatId: this.nextChatId }));
      } catch (err) {
        console.error("[workfm-queue] failed to persist chat:", err);
      }
    });
  }

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
    this.pruneExpiredChat();
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
    this.pruneExpiredChat();
    const trimmed = text.trim().slice(0, MAX_CHAT_MESSAGE_LENGTH);
    if (!trimmed) throw new Error("message can't be empty");
    const message: ChatMessage = { id: this.nextChatId++, name, text: trimmed, at: Date.now() };
    this.chat.push(message);
    if (this.chat.length > MAX_CHAT_MESSAGES) this.chat.shift();
    this.saveChatState();
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
        // Burst-on-connect: hand over whatever's in the recent backlog
        // immediately (all at once, not paced), so this listener's audio
        // element gets several seconds of decode buffer up front instead
        // of only building it up at the live real-time trickle rate —
        // see BACKLOG_BYTES' comment for why this matters. Framed through
        // the exact same ICY-metadata accounting as the live path so
        // metaint boundaries stay correct for what follows.
        for (const chunk of self.backlogChunks) {
          try {
            if (!sub.wantsMeta) {
              controller.enqueue(chunk);
            } else {
              self.pushWithMeta(sub, chunk);
            }
          } catch {
            break; // controller already closed/errored — subscribers.add() below is skipped implicitly via cancel()
          }
        }
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
        await attachSavedUpload(libraryId, savedPath);
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
    if (removed) this.cleanupPrefetch(removed.id);
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
    if (this.current.special === "announcement" || this.current.special === "spisetid") {
      return { ok: false, error: "this can't be skipped" };
    }
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

  /**
   * Admin test hook (Dashboard's "Force spisetid" button): immediately
   * kicks off a full alarm→pause→resume cycle on its own clock (same
   * durations as the real 11:30 schedule), regardless of the actual
   * Danish wall-clock time — so an admin can verify/preview the feature
   * without waiting for lunchtime. A no-op if one's already running.
   */
  forceSpiseTid(): void {
    if (this.forcedSpiseTid) return;
    const now = Date.now();
    this.forcedSpiseTid = { alarmEndsAt: now + SPISETID_ALARM_DURATION_MS, endsAt: now + SPISETID_TOTAL_DURATION_MS };
    this.suppressScheduledSpiseTidUntil = null;
  }

  /**
   * Admin control (Dashboard's "Stop spisetid" button): ends spisetid right
   * now, whether it's a forced test cycle or the real 11:30 schedule —
   * music resumes at the very next schedule check. If it was the real
   * schedule, also suppresses it from immediately re-triggering for a
   * while (otherwise the next check, moments later, would just see the
   * same real time window and turn it right back on).
   */
  stopSpiseTid(): void {
    this.forcedSpiseTid = null;
    this.suppressScheduledSpiseTidUntil = Date.now() + 2 * 60 * 60 * 1000; // comfortably past any single day's window
  }

  /** Whichever spisetid phase should be active *right now*, folding in any
   * admin override (forced test cycle, or a stop-triggered suppression) on
   * top of the real weekly schedule — see enforceSpiseTidSchedule() below,
   * which is what actually acts on this every tick. */
  private computeSpiseTidPhase(): SpiseTidPhase | null {
    const now = Date.now();
    if (this.forcedSpiseTid) {
      if (now < this.forcedSpiseTid.alarmEndsAt) return "alarm";
      if (now < this.forcedSpiseTid.endsAt) return "pause";
      this.forcedSpiseTid = null; // forced cycle finished naturally
    }
    if (this.suppressScheduledSpiseTidUntil !== null) {
      if (now < this.suppressScheduledSpiseTidUntil) return null;
      this.suppressScheduledSpiseTidUntil = null;
    }
    return getScheduledSpiseTidPhase();
  }

  /**
   * Ticks every SPISETID_CHECK_INTERVAL_MS (see constructor): recomputes
   * whether spisetid should be active and, on any change, interrupts
   * whatever's currently playing (killPlayback()) so loop() reacts within
   * one tick instead of waiting for the current track to finish naturally
   * — this is what lets the 11:30 alarm cut in mid-song. loop() itself
   * reads `spiseTidPhase` at the top of every iteration (see runSpiseTid()).
   */
  private enforceSpiseTidSchedule() {
    const phase = this.computeSpiseTidPhase();
    if (phase === this.spiseTidPhase) return;
    if (phase === "alarm") this.spiseTidPrefetchDone = false; // fresh cycle — allow prefetching again
    this.spiseTidPhase = phase;
    this.killPlayback();
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

  /** Speculatively picks (and caches) what the auto-DJ would play next,
   * without waiting for the request queue to actually go empty for real —
   * so scheduleLookahead() can start downloading it early. Safe to call
   * repeatedly; only actually consumes a shuffle slot the first time.
   * Paired with takeAutoDjItem() below, which must be used instead of
   * pickAutoDjEntry()/buildAutoDjItem() directly once the pick is really
   * needed, so the same track isn't picked twice. */
  private peekAutoDjItem(): QueueItem | null {
    if (this.pendingAutoDjPick === null) {
      const entry = this.pickAutoDjEntry();
      this.pendingAutoDjPick = entry ? this.buildAutoDjItem(entry) : null;
    }
    return this.pendingAutoDjPick;
  }

  /** Returns the item peekAutoDjItem() already committed to, if any,
   * otherwise picks a fresh one — see peekAutoDjItem()'s doc comment. */
  private takeAutoDjItem(): QueueItem | null {
    if (this.pendingAutoDjPick !== null) {
      const item = this.pendingAutoDjPick;
      this.pendingAutoDjPick = null;
      return item;
    }
    const entry = this.pickAutoDjEntry();
    return entry ? this.buildAutoDjItem(entry) : null;
  }

  /** Where a queue item's audio already lives on disk right now, if
   * anywhere — an upload's file (always local), a youtube item that's
   * already been fully downloaded ahead of time (see scheduleLookahead()/
   * prefetchQueue()), or a youtube item that's been permanently cached from
   * an earlier play/prefetch (see cacheYoutubeDownload()). Null if it'd
   * still need a live yt-dlp pipe. */
  private resolveLocalFilePath(item: QueueItem): string | null {
    if (item.source === "upload") return item.diskPath ?? null;
    return this.prefetchedFiles.get(item.id) ?? getCachedYoutubeFile(item.libraryId);
  }

  /**
   * Fire-and-forget: makes sure `item`'s video ends up in YOUTUBE_CACHE_DIR
   * even when it's being played live (no prefetched temp file to promote —
   * see cacheYoutubeDownload()) by kicking an independent background
   * yt-dlp download straight to the cache. No-op if it's already cached,
   * or a download for this id is already in flight (e.g. scheduleLookahead()
   * is already handling it as someone else's "upcoming" track).
   */
  private ensureYoutubeCached(item: QueueItem) {
    if (getCachedYoutubeFile(item.libraryId) || this.lookaheadInFlight.has(item.id)) return;
    this.lookaheadInFlight.add(item.id);
    this.downloadYoutubeToFile(item)
      .then((tempPath) => {
        if (!tempPath) return;
        this.cacheYoutubeDownload(item, tempPath).then((cached) => {
          if (!cached) rm(tempPath, { force: true }).catch(() => {});
        });
      })
      .finally(() => this.lookaheadInFlight.delete(item.id));
  }

  /**
   * Promotes a one-shot temp download (from prefetchQueue()'s spisetid
   * prewarm, scheduleLookahead(), or a first-time live play below) into the
   * permanent YOUTUBE_CACHE_DIR, so any future requeue of the same video —
   * from "History"/"Most liked"/"Most played", or just someone pasting the
   * same link again — plays straight off disk instead of paying for
   * another yt-dlp download. Best-effort: any failure just means this
   * particular copy doesn't get reused later (falls back to a fresh
   * download next time), never breaks current playback. No-op if this
   * video's already cached from an earlier play/prefetch.
   */
  private async cacheYoutubeDownload(item: QueueItem, tempFilePath: string): Promise<boolean> {
    if (getCachedYoutubeFile(item.libraryId)) return false;
    try {
      await mkdir(YOUTUBE_CACHE_DIR, { recursive: true });
      const cachedPath = path.join(YOUTUBE_CACHE_DIR, `${item.videoId}.mp3`);
      await rename(tempFilePath, cachedPath);
      await attachYoutubeCache(
        {
          libraryId: item.libraryId,
          source: "youtube",
          videoId: item.videoId,
          url: item.url,
          artist: item.artist,
          title: item.title,
          addedBy: item.addedBy,
        },
        cachedPath
      );
      return true;
    } catch (err) {
      console.error(`[workfm-queue] failed to cache "${item.artist} - ${item.title}" for future requeues:`, err);
      return false;
    }
  }

  /** Downloads one YouTube item's audio straight to disk (shared by
   * prefetchQueue()'s spisetid prewarm and scheduleLookahead() below).
   * Best-effort: returns null (rather than throwing) on any failure, so a
   * failed download just means that track falls back to its normal live
   * playback path later. */
  private async downloadYoutubeToFile(item: { url: string; artist: string; title: string }): Promise<string | null> {
    await mkdir(PREFETCH_DIR, { recursive: true });
    const id = crypto.randomUUID();
    const outputTemplate = path.join(PREFETCH_DIR, `${id}.%(ext)s`);
    const finalPath = path.join(PREFETCH_DIR, `${id}.mp3`);
    try {
      const proc = Bun.spawn(
        ["yt-dlp", ...YTDLP_COOKIE_ARGS, ...YTDLP_EXTRA_ARGS, "-x", "--audio-format", "mp3", "--no-playlist", "--quiet", "--no-warnings", "-o", outputTemplate, item.url],
        { stdout: "pipe", stderr: "pipe" }
      );
      const exitCode = await proc.exited;
      if (exitCode === 0 && (await Bun.file(finalPath).exists())) return finalPath;
    } catch (err) {
      console.error(`[workfm-queue] failed to download "${item.artist} - ${item.title}":`, err);
    }
    return null;
  }

  /**
   * Kicks off a background download of whatever's coming up after the
   * track that's *about to* start playing — called once per loop()
   * iteration, right as that track begins — so its audio has that whole
   * track's duration to arrive on disk. If it makes it in time,
   * playUpload() below crossfades smoothly into it instead of the usual
   * silence-bridged hard cut. A no-op for uploads (already local) or if a
   * download for this id is already in flight/done.
   */
  private scheduleLookahead(upcoming: QueueItem | null) {
    if (!upcoming || upcoming.source !== "youtube") return;
    if (this.prefetchedFiles.has(upcoming.id) || this.lookaheadInFlight.has(upcoming.id)) return;
    this.lookaheadInFlight.add(upcoming.id);
    this.downloadYoutubeToFile(upcoming)
      .then((filePath) => {
        if (filePath) this.prefetchedFiles.set(upcoming.id, filePath);
      })
      .finally(() => this.lookaheadInFlight.delete(upcoming.id));
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
    while (this.currentGen === gen && this.queue.length === 0 && this.emptySince !== null && !this.spiseTidPhase) {
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
      if (this.spiseTidPhase) {
        await this.runSpiseTid(this.spiseTidPhase);
        continue;
      }
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
        const autoItem = this.takeAutoDjItem();
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

      // Whatever's genuinely up next (a real request, or — if the request
      // queue's empty — the auto-DJ's next speculative pick) starts
      // downloading now, in the background, so playEntry() below has a
      // shot at crossfading smoothly into it instead of the usual
      // silence-bridged hard cut. See scheduleLookahead()'s doc comment.
      const upcoming = this.queue.length > 0 ? this.queue[0]! : this.peekAutoDjItem();
      this.scheduleLookahead(upcoming);

      let playedFully = false;
      let handoff: { item: QueueItem; playedFully: boolean } | null = null;
      try {
        handoff = await this.playEntry(item, gen, upcoming);
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

      if (handoff) {
        // playEntry() already crossfaded straight into `upcoming` and
        // played it all the way out (see playUpload()'s crossfade branch)
        // — all the "now playing" bookkeeping (current/currentStartedAt/
        // recordPlay/vote-clearing) for it already happened live, right as
        // the crossfade began. Just consume it from wherever it was
        // pending so this loop doesn't play it again from scratch.
        const consumed = handoff.item;
        if (this.queue[0]?.id === consumed.id) this.queue.shift();
        else if (this.pendingAutoDjPick?.id === consumed.id) this.pendingAutoDjPick = null;
        if (handoff.playedFully && this.repeatArmed) {
          this.queue.unshift(consumed);
        } else if (consumed.source === "upload") {
          this.cleanupUpload(consumed.id).catch(() => {});
        }
      }

      await this.maybeInsertSpecials();
    }
  }

  /**
   * Runs one iteration of the active spisetid sub-phase — called from the
   * very top of loop() whenever `spiseTidPhase` is set, in place of normal
   * track playback. Each call handles *one* phase's worth of playback (an
   * alarm loop, or the silent prefetch pause) and returns as soon as
   * enforceSpiseTidSchedule() changes the phase (via killPlayback()), at
   * which point loop() re-reads `spiseTidPhase` and calls back in for
   * whatever's next — so this never has to know what comes after it.
   */
  private async runSpiseTid(phase: SpiseTidPhase): Promise<void> {
    const alarmItem: QueueItem = {
      id: this.nextId++,
      videoId: "",
      url: "",
      artist: "",
      title: "ANNOUNCEMENT",
      addedBy: "Radio Bækgaard",
      addedAt: Date.now(),
      source: "upload",
      libraryId: "spisetid",
      special: "spisetid",
    };
    this.current = alarmItem;
    this.currentMetaString = "ANNOUNCEMENT";
    this.currentStartedAt = Date.now();
    const gen = ++this.currentGen;

    if (phase === "pause") {
      // The queue's paused anyway — a perfect, otherwise-wasted window to
      // warm up every requested track so they start playing instantly once
      // 12:00 hits, instead of each one paying yt-dlp's usual startup cost.
      this.prefetchQueue().catch((err) => console.error("[workfm-queue] spisetid prefetch failed:", err));
      await this.streamGeneratedAudio(
        ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"],
        gen,
        () => this.spiseTidPhase === "pause"
      );
      return;
    }

    // Alarm phase: loop admin-uploaded "spisetid" files (see
    // workfmAnnouncements.ts) back-to-back for as long as the phase lasts;
    // falls back to a synthesized siren tone if none have been uploaded, so
    // the alarm always sounds even on a fresh install.
    while (this.currentGen === gen && this.spiseTidPhase === "alarm") {
      const [entry] = await pickRandomAnnouncementFiles("spisetid", 1);
      if (entry) {
        try {
          await this.playUpload({ ...alarmItem, diskPath: announcementFilePath(entry) }, gen);
        } catch (err) {
          console.error("[workfm-queue] failed to play spisetid alarm file:", err);
        }
      } else {
        await this.streamGeneratedAudio(
          ["-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=44100", "-af", "tremolo=f=3:d=0.9"],
          gen,
          () => this.spiseTidPhase === "alarm"
        );
      }
    }
  }

  /**
   * Downloads every currently-queued (real, not auto-DJ) YouTube request's
   * audio straight to disk, ahead of time, so playEntry() can play it
   * straight off disk instead of piping live through yt-dlp — see
   * playEntry()'s prefetchedFiles check. Only ever called during the
   * spisetid pause window (see runSpiseTid()) and only does this once per
   * window (spiseTidPrefetchDone). Best-effort per track: a failed
   * download just means that one track falls back to the normal live path
   * later, same as if it had never been prefetched.
   */
  private async prefetchQueue(): Promise<void> {
    if (this.spiseTidPrefetchDone) return;
    this.spiseTidPrefetchDone = true;
    const targets = this.queue.filter((item) => item.source === "youtube" && !this.prefetchedFiles.has(item.id));
    if (targets.length === 0) return;

    const PREFETCH_CONCURRENCY = 2; // modest — this is a courtesy prewarm, not worth hammering yt-dlp/network for
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const item = targets[cursor++]!;
        // Bail out early if we've left the pause window (e.g. an admin hit
        // "Stop spisetid") — no point starting fresh downloads for a
        // prefetch window that's already over.
        if (this.spiseTidPhase !== "pause") return;
        const filePath = await this.downloadYoutubeToFile(item);
        if (filePath) this.prefetchedFiles.set(item.id, filePath);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PREFETCH_CONCURRENCY, targets.length) }, worker));
  }

  /** Deletes a queue item's prefetched cache file, if any — called once
   * it's actually consumed (playEntry()) or if it's removed from the queue
   * before ever getting its turn (removeFromQueue()). */
  private cleanupPrefetch(id: number) {
    const filePath = this.prefetchedFiles.get(id);
    if (!filePath) return;
    this.prefetchedFiles.delete(id);
    rm(filePath, { force: true }).catch(() => {});
  }

  /**
   * Streams an ffmpeg-generated (lavfi) audio source — silence or a
   * synthesized tone — to subscribers for as long as `shouldContinue()`
   * keeps returning true and `gen` stays current, mirroring playSilence()'s
   * structure. Used by runSpiseTid() for both the pause window's silence
   * and the alarm's fallback siren tone (when no admin-uploaded alarm file
   * exists).
   */
  private async streamGeneratedAudio(lavfiArgs: string[], gen: number, shouldContinue: () => boolean): Promise<void> {
    const ffmpeg = Bun.spawn(
      ["ffmpeg", "-hide_banner", "-loglevel", "error", "-re", ...lavfiArgs, ...AUDIO_ARGS, "pipe:1"],
      { stdout: "pipe", stderr: "pipe" }
    );
    this.ytdlpProc = null;
    this.ffmpegProc = ffmpeg;
    try {
      const reader = ffmpeg.stdout.getReader();
      while (true) {
        if (this.currentGen !== gen || !shouldContinue()) return;
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

  private async playEntry(
    entry: QueueItem,
    gen: number,
    upcoming?: QueueItem | null
  ): Promise<{ item: QueueItem; playedFully: boolean } | null> {
    if (entry.source === "upload") return this.playUpload(entry, gen, upcoming);

    // If this track got downloaded ahead of time (spisetid's prefetchQueue()
    // prewarm, or scheduleLookahead() prepping it as someone else's
    // "upcoming" track), play straight off that file instead of piping it
    // live through yt-dlp again — same mechanism as an uploaded mp3.
    // Promoted into the permanent YOUTUBE_CACHE_DIR afterwards (see
    // cacheYoutubeDownload()) rather than deleted, unless it's already
    // cached from an earlier play, in which case the temp copy's just
    // redundant and gets cleaned up as before.
    const prefetchedPath = this.prefetchedFiles.get(entry.id);
    if (prefetchedPath) {
      this.prefetchedFiles.delete(entry.id);
      try {
        return await this.playUpload({ ...entry, diskPath: prefetchedPath }, gen, upcoming);
      } finally {
        this.cacheYoutubeDownload(entry, prefetchedPath).then((cached) => {
          if (!cached) rm(prefetchedPath, { force: true }).catch(() => {});
        });
      }
    }

    // Already permanently cached from an earlier play/prefetch — play
    // straight off that shared file (never deleted afterward; it's meant
    // to be reused indefinitely).
    const cachedPath = getCachedYoutubeFile(entry.libraryId);
    if (cachedPath) return this.playUpload({ ...entry, diskPath: cachedPath }, gen, upcoming);

    // First time this video's ever been played with no lookahead lead time
    // (e.g. it's the very next thing to play and got requested only just
    // now) — kick a background download to seed the cache for next time,
    // in parallel with the live pipe below. Doubles the bandwidth for this
    // one play, but means every *subsequent* request/requeue of the same
    // video skips yt-dlp entirely — a one-time cost that pays for itself
    // the moment it's ever requested again.
    this.ensureYoutubeCached(entry);

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
      if (this.currentGen !== gen) return null; // skipped mid-track
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
    // Live-piped tracks never crossfade — see playUpload()'s crossfade
    // branch, which only kicks in for tracks already sitting on disk.
    return null;
  }

  /** Plays a locally-uploaded mp3 straight through ffmpeg (no yt-dlp needed).
   * If `upcoming`'s audio is already sitting on disk (see
   * scheduleLookahead()/resolveLocalFilePath()) and this track's long
   * enough to spare it, crosses over into it near the end instead of
   * cutting to the usual silence bridge — see runCrossfade() — and keeps
   * playing it out to completion, returning it as a "handoff" so loop()
   * knows not to play it again from scratch. */
  private async playUpload(
    entry: QueueItem,
    gen: number,
    upcoming?: QueueItem | null
  ): Promise<{ item: QueueItem; playedFully: boolean } | null> {
    const filePath = entry.diskPath;
    if (!filePath) throw new Error("uploaded file is missing");

    const upcomingFilePath = upcoming ? this.resolveLocalFilePath(upcoming) : null;
    const durationSec = entry.durationSec ?? (await probeFileDurationSec(filePath));
    const canCrossfade = !!upcoming && !!upcomingFilePath && !!durationSec && durationSec > CROSSFADE_SEC * 2;
    const mainDurationSec = canCrossfade ? durationSec! - CROSSFADE_SEC : null;

    // `-re` paces output to real playback speed, same as the YouTube path.
    // `-t` (only set when about to crossfade) stops this main phase short
    // by CROSSFADE_SEC, so the crossfade below picks up exactly where it
    // left off instead of the two overlapping.
    const ffmpegArgs = ["-hide_banner", "-loglevel", "error", "-re", "-i", filePath];
    if (mainDurationSec != null) ffmpegArgs.push("-t", String(mainDurationSec));
    ffmpegArgs.push("-vn", ...AUDIO_ARGS, "pipe:1");
    const ffmpeg = Bun.spawn(["ffmpeg", ...ffmpegArgs], { stdout: "pipe", stderr: "pipe" });
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
        if (this.currentGen !== gen) return null; // skipped mid-track
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

    if (this.currentGen !== gen || !canCrossfade) return null;
    return this.crossfadeInto(filePath, durationSec!, upcomingFilePath!, upcoming!, gen);
  }

  /**
   * Blends the tail of the track that just finished (in `currentFilePath`)
   * with the head of `upcoming` (already on disk at `upcomingFilePath`) via
   * ffmpeg's acrossfade filter, broadcasts that blended segment in place of
   * the usual silence bridge, then keeps playing `upcoming` out from where
   * the blend left off, all the way to its natural end (or a skip).
   * "Now playing" state flips over to `upcoming` right as the blend starts,
   * same as any other track change. Returns `upcoming` as a handoff once
   * committed — even if something goes wrong partway through — so loop()
   * knows it's already been (at least partly) played and shouldn't queue
   * it up again.
   */
  private async crossfadeInto(
    currentFilePath: string,
    currentDurationSec: number,
    upcomingFilePath: string,
    upcoming: QueueItem,
    gen: number
  ): Promise<{ item: QueueItem; playedFully: boolean } | null> {
    this.current = upcoming;
    this.currentMetaString = `${upcoming.artist} - ${upcoming.title}`;
    // It's effectively CROSSFADE_SEC seconds in already once the blend
    // starts, so the elapsed/total indicator doesn't jump backwards.
    this.currentStartedAt = Date.now() - CROSSFADE_SEC * 1000;
    this.skipVotes.clear();
    this.repeatVotes.clear();
    this.repeatArmed = false;
    this.nextVotes.delete(upcoming.id);
    recordPlay({
      libraryId: upcoming.libraryId,
      source: upcoming.source,
      videoId: upcoming.videoId,
      url: upcoming.url,
      artist: upcoming.artist,
      title: upcoming.title,
      addedBy: upcoming.addedBy,
    });
    // Consumed either way from here on — it's already "now playing".
    this.prefetchedFiles.delete(upcoming.id);

    const seekSec = Math.max(0, currentDurationSec - CROSSFADE_SEC);
    const ffmpeg = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        String(seekSec),
        "-i",
        currentFilePath,
        "-i",
        upcomingFilePath,
        "-filter_complex",
        `acrossfade=d=${CROSSFADE_SEC}:curve1=tri:curve2=tri`,
        "-vn",
        ...AUDIO_ARGS,
        "pipe:1",
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    this.ffmpegProc = ffmpeg;
    const ffmpegStderr = drainText(ffmpeg.stderr);
    try {
      const reader = ffmpeg.stdout.getReader();
      await relayPaced(reader, (chunk) => this.broadcast(chunk), () => this.currentGen !== gen, AUDIO_BYTES_PER_SEC, 0);
      const ffExit = await ffmpeg.exited;
      if (ffExit !== 0 && this.currentGen === gen) {
        const ffErr = (await ffmpegStderr).trim();
        console.error(`[workfm-queue] crossfade into "${upcoming.artist} - ${upcoming.title}" failed: ffmpeg exited with code ${ffExit}` + (ffErr ? `\n${ffErr}` : ""));
      }
    } catch (err) {
      console.error(`[workfm-queue] crossfade into "${upcoming.artist} - ${upcoming.title}" failed:`, err);
    } finally {
      this.ffmpegProc = null;
      try {
        ffmpeg.kill();
      } catch {
        // already exited
      }
    }

    if (this.currentGen !== gen) {
      rm(upcomingFilePath, { force: true }).catch(() => {});
      return { item: upcoming, playedFully: false };
    }

    // Play the rest of `upcoming`'s file out, starting right after the
    // portion the crossfade above already covered.
    const tailFfmpeg = Bun.spawn(
      ["ffmpeg", "-hide_banner", "-loglevel", "error", "-re", "-ss", String(CROSSFADE_SEC), "-i", upcomingFilePath, "-vn", ...AUDIO_ARGS, "pipe:1"],
      { stdout: "pipe", stderr: "pipe" }
    );
    this.ffmpegProc = tailFfmpeg;
    const tailStderr = drainText(tailFfmpeg.stderr);
    let playedFully = false;
    try {
      const reader = tailFfmpeg.stdout.getReader();
      while (true) {
        if (this.currentGen !== gen) break; // skipped mid-track — still a genuine (partial) play
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) this.broadcast(value);
      }
      playedFully = this.currentGen === gen;
      const ffExit = await tailFfmpeg.exited;
      if (ffExit !== 0 && this.currentGen === gen) {
        const ffErr = (await tailStderr).trim();
        console.error(`[workfm-queue] post-crossfade playback of "${upcoming.artist} - ${upcoming.title}" failed: ffmpeg exited with code ${ffExit}` + (ffErr ? `\n${ffErr}` : ""));
      }
    } finally {
      this.ffmpegProc = null;
      try {
        tailFfmpeg.kill();
      } catch {
        // already exited
      }
      rm(upcomingFilePath, { force: true }).catch(() => {});
    }

    return { item: upcoming, playedFully };
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
    this.backlogChunks.push(chunk);
    this.backlogBytes += chunk.length;
    while (this.backlogBytes > BACKLOG_BYTES && this.backlogChunks.length > 1) {
      const dropped = this.backlogChunks.shift()!;
      this.backlogBytes -= dropped.length;
    }
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
    if (this.spiseTidTimer) clearInterval(this.spiseTidTimer);
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
    for (const id of [...this.prefetchedFiles.keys()]) {
      this.cleanupPrefetch(id);
    }
    this.queue = [];
  }
}

export { WorkFmQueueStream };
