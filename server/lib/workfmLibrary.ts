import { readFileSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// WorkFM library: a global, persistent (JSON on disk) record of every track
// that's ever actually played across every room (see workfmRooms.ts) — plus
// likes on each one. This is what powers the "History" and "Most liked"
// views, and tracks which uploaded mp3s are still saved on disk for
// requeuing (see saveForLater on QueueItem in workfmQueue.ts). Rooms
// themselves are ephemeral/in-memory, but this library survives room
// teardown and server restarts.
// ---------------------------------------------------------------------------

const LIBRARY_PATH = path.join(import.meta.dir, "..", "data", "workfm-library.json");
export const SAVED_UPLOADS_DIR = path.join(import.meta.dir, "..", "data", "workfm-saved-uploads");
// A permanent, keep-forever cache of every YouTube track that's already
// been downloaded once (either from actually playing, or a lookahead/
// spisetid prefetch — see workfmQueue.ts's cacheYoutubeDownload()), so
// requeuing the same video later plays straight off disk instead of
// re-fetching it from YouTube from scratch. Just mp3 files named by video
// ID — workfm-library.json (this file's own store) already *is* the
// metadata (artist/title/playCount/etc.) for each one, keyed the same way,
// so there's no separate metadata file to keep in sync. Reuses the same
// savedFilePath field/dir-deletion mechanism as saved uploads (see
// deleteLibraryEntry()).
export const YOUTUBE_CACHE_DIR = path.join(import.meta.dir, "..", "data", "music");
// Cap on total disk space the YouTube cache is allowed to use — uploads are
// exempt from this (and from any eviction below) since they can't be
// re-fetched from YouTube if lost; a deleted upload is just gone. Once the
// cache is over the cap, enforceYoutubeCacheLimit() evicts the
// least-played cached YouTube entries (ties broken by least-recently-
// played) until it's back under, freeing room for newer/more-played tracks.
const YOUTUBE_CACHE_LIMIT_BYTES = 20 * 1024 * 1024 * 1024;

export interface LibraryTrack {
  id: string; // "yt:<videoId>" or "up:<uuid>" — stable across replays/requeues
  source: "youtube" | "upload";
  videoId?: string;
  url?: string;
  artist: string;
  title: string;
  addedBy: string; // whoever first added/uploaded it
  firstPlayedAt: number;
  lastPlayedAt: number;
  playCount: number;
  likes: string[]; // lowercased names who've liked it (toggle — also doubles as de-dup)
  /** Set while a local copy of this track's audio is retained on disk and
   * requeueable without re-fetching: for uploads, cleared only if the
   * uploader opted out of "save for later" or an admin explicitly deletes
   * it; for YouTube tracks, this is just a speed-up cache (the track's
   * still always "available" via yt-dlp even without it — see summarize()'s
   * `available` field) that's populated the first time it's ever
   * downloaded, and subject to eviction under YOUTUBE_CACHE_LIMIT_BYTES
   * (see enforceYoutubeCacheLimit()) — uploads never get evicted this way.
   * Kept indefinitely otherwise, until an admin explicitly deletes it (see
   * deleteLibraryEntry()) — no automatic time-based expiry. */
  savedFilePath?: string;
  /** Byte size of savedFilePath, cached at attach time so
   * enforceYoutubeCacheLimit() doesn't need to stat every cached file on
   * every check — undefined whenever savedFilePath is. */
  savedFileBytes?: number;
}

export interface LibraryTrackSummary {
  id: string;
  source: "youtube" | "upload";
  artist: string;
  title: string;
  addedBy: string;
  firstPlayedAt: number;
  lastPlayedAt: number;
  playCount: number;
  likes: number;
  likedByMe: boolean;
  /** Whether this can still be requeued — always true for YouTube, only
   * true for uploads while the file is still saved on disk. */
  available: boolean;
}

let library = new Map<string, LibraryTrack>();

function load() {
  try {
    const raw = readFileSync(LIBRARY_PATH, "utf-8");
    const entries = JSON.parse(raw) as LibraryTrack[];
    library = new Map(entries.map((e) => [e.id, e]));
  } catch {
    library = new Map();
  }
}
load();

let saveQueued = false;
async function save() {
  if (saveQueued) return; // a save is already about to flush the latest state
  saveQueued = true;
  queueMicrotask(async () => {
    saveQueued = false;
    try {
      await mkdir(path.dirname(LIBRARY_PATH), { recursive: true });
      await writeFile(LIBRARY_PATH, JSON.stringify([...library.values()], null, 2));
    } catch (err) {
      console.error("[workfm-library] failed to persist library:", err);
    }
  });
}

function summarize(entry: LibraryTrack, viewerName?: string): LibraryTrackSummary {
  return {
    id: entry.id,
    source: entry.source,
    artist: entry.artist,
    title: entry.title,
    addedBy: entry.addedBy,
    firstPlayedAt: entry.firstPlayedAt,
    lastPlayedAt: entry.lastPlayedAt,
    playCount: entry.playCount,
    likes: entry.likes.length,
    likedByMe: !!viewerName && entry.likes.includes(viewerName.toLowerCase()),
    available: entry.source === "youtube" || !!entry.savedFilePath,
  };
}

/** Minimal shape of a played track — matches the relevant subset of
 * workfmQueue.ts's QueueItem, kept separate to avoid a circular import. */
export interface PlayedTrack {
  libraryId: string;
  source: "youtube" | "upload";
  videoId: string;
  url: string;
  artist: string;
  title: string;
  addedBy: string;
}

/** Ensures a library entry exists for `item` (with playCount 0 if it's
 * never actually played yet) — shared by registerUpload() (an upload saved
 * "for later" before its own turn in the queue) and attachYoutubeCache()
 * (a track can be fully downloaded via scheduleLookahead()'s prefetch
 * before its own turn to play/recordPlay() comes up). recordPlay() still
 * handles the real play-count bookkeeping once a track actually plays —
 * this only creates the placeholder if missing. */
function ensureLibraryEntry(item: PlayedTrack) {
  if (library.has(item.libraryId)) return;
  library.set(item.libraryId, {
    id: item.libraryId,
    source: item.source,
    videoId: item.source === "youtube" ? item.videoId : undefined,
    url: item.source === "youtube" ? item.url : undefined,
    artist: item.artist,
    title: item.title,
    addedBy: item.addedBy,
    firstPlayedAt: 0,
    lastPlayedAt: 0,
    playCount: 0,
    likes: [],
  });
  save();
}

/** Ensures a library entry exists for `item` with playCount 0 — called the
 * moment an mp3 is uploaded (before it's necessarily played), so a saved
 * copy can be attached (see attachSavedUpload) and show up in "Saved
 * uploads" right away instead of waiting for its turn in the queue. */
export function registerUpload(item: PlayedTrack) {
  ensureLibraryEntry(item);
}

/** Records that `item` just started playing — upserts its library entry. */
export function recordPlay(item: PlayedTrack) {
  const now = Date.now();
  const existing = library.get(item.libraryId);
  if (existing) {
    existing.lastPlayedAt = now;
    existing.playCount += 1;
    existing.title = item.title;
    existing.artist = item.artist;
  } else {
    library.set(item.libraryId, {
      id: item.libraryId,
      source: item.source,
      videoId: item.source === "youtube" ? item.videoId : undefined,
      url: item.source === "youtube" ? item.url : undefined,
      artist: item.artist,
      title: item.title,
      addedBy: item.addedBy,
      firstPlayedAt: now,
      lastPlayedAt: now,
      playCount: 1,
      likes: [],
    });
  }
  save();
}

/** Attaches a persisted, on-disk copy of an uploaded mp3 to its library
 * entry so it can be requeued later — called immediately at upload time
 * when "save for later" is checked (see addUploadToQueue in workfmQueue.ts),
 * not just once it's finished playing. Kept on disk indefinitely, until an
 * admin explicitly deletes it (see deleteLibraryEntry()) — never subject to
 * the YouTube cache's size-based eviction. */
export async function attachSavedUpload(libraryId: string, filePath: string) {
  const entry = library.get(libraryId);
  if (!entry) return;
  entry.savedFilePath = filePath;
  entry.savedFileBytes = await statSizeSafe(filePath);
  save();
}

/** Attaches a permanently-cached local copy of a YouTube track's audio to
 * its library entry, so future requeues of the same video play straight
 * off disk instead of a fresh yt-dlp fetch — called the first time any
 * copy of `item` finishes downloading (whether that's from actually
 * playing it live, or a lookahead/spisetid prefetch; see
 * cacheYoutubeDownload() in workfmQueue.ts). Creates the library entry if
 * this download finished before the track's own first real play (e.g. a
 * lookahead prefetch for a video nobody's ever requested before). Then
 * enforces YOUTUBE_CACHE_LIMIT_BYTES, evicting the least-played cached
 * entries if this pushed the cache over the cap. */
export async function attachYoutubeCache(item: PlayedTrack, filePath: string) {
  ensureLibraryEntry(item);
  const entry = library.get(item.libraryId)!;
  entry.savedFilePath = filePath;
  entry.savedFileBytes = await statSizeSafe(filePath);
  save();
  await enforceYoutubeCacheLimit();
}

/** Best-effort file size lookup — undefined (rather than throwing) if the
 * file's already gone by the time we get to stat it. */
async function statSizeSafe(filePath: string): Promise<number | undefined> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return undefined;
  }
}

/**
 * Evicts cached YouTube files (never uploads — those are exempt, see
 * LibraryTrack.savedFilePath's doc) until total usage is back under
 * YOUTUBE_CACHE_LIMIT_BYTES, starting with the least-played entries (ties
 * broken by least-recently-played) so frequently-requested/auto-DJ'd
 * tracks are the last to go. Best-effort: a failed delete just gets
 * skipped (that entry's bytes still count against the cap, so it'll be
 * retried on the next attach if still over).
 */
async function enforceYoutubeCacheLimit(): Promise<void> {
  const cached = [...library.values()]
    .filter((e) => e.source === "youtube" && !!e.savedFilePath)
    .sort((a, b) => a.playCount - b.playCount || a.lastPlayedAt - b.lastPlayedAt);
  let totalBytes = cached.reduce((sum, e) => sum + (e.savedFileBytes ?? 0), 0);
  if (totalBytes <= YOUTUBE_CACHE_LIMIT_BYTES) return;

  let changed = false;
  for (const entry of cached) {
    if (totalBytes <= YOUTUBE_CACHE_LIMIT_BYTES) break;
    try {
      await rm(entry.savedFilePath!, { force: true });
    } catch (err) {
      console.error(`[workfm-library] failed to evict cached file for ${entry.id}:`, err);
      continue;
    }
    totalBytes -= entry.savedFileBytes ?? 0;
    entry.savedFilePath = undefined;
    entry.savedFileBytes = undefined;
    changed = true;
  }
  if (changed) save();
}

/** The cached local file for a YouTube library entry, if one's been
 * downloaded before — null if it's never been cached (first play ever, the
 * cache write failed/hasn't finished yet, or it's since been evicted to
 * stay under YOUTUBE_CACHE_LIMIT_BYTES) or the entry doesn't exist. */
export function getCachedYoutubeFile(libraryId: string): string | null {
  const entry = library.get(libraryId);
  return entry?.source === "youtube" ? entry.savedFilePath ?? null : null;
}

/** Toggles `name`'s like on a track; returns the updated public state, or
 * null if the track isn't in the library (e.g. it's never actually played). */
export function toggleLike(id: string, name: string): { likes: number; liked: boolean } | null {
  const entry = library.get(id);
  if (!entry) return null;
  const key = name.toLowerCase();
  const idx = entry.likes.indexOf(key);
  if (idx === -1) entry.likes.push(key);
  else entry.likes.splice(idx, 1);
  save();
  return { likes: entry.likes.length, liked: idx === -1 };
}

export function getLibraryTrack(id: string): LibraryTrack | null {
  return library.get(id) ?? null;
}

/** Admin-only: permanently removes a track from the library (History/Most
 * liked/Most played/Saved uploads) and best-effort deletes its saved file
 * from disk if it still has one. Returns false if `id` isn't in the
 * library. Does not affect anything currently queued/playing elsewhere —
 * it's just the persisted record of what's been played. */
export async function deleteLibraryEntry(id: string): Promise<boolean> {
  const entry = library.get(id);
  if (!entry) return false;
  if (entry.savedFilePath) {
    await rm(entry.savedFilePath, { force: true }).catch((err) =>
      console.error(`[workfm-library] failed to delete saved file for ${id}:`, err)
    );
  }
  library.delete(id);
  await save();
  return true;
}

/** Library ids of every track that's actually been played at least once and
 * is still playable right now (YouTube is always assumed playable; an
 * upload only counts while its file is still saved on disk) — this is the
 * pool the auto-DJ shuffles through when the request queue runs dry (see
 * WorkFmQueueStream's auto-DJ logic in workfmQueue.ts). Order is arbitrary;
 * the caller is responsible for shuffling. */
export function listPlayableHistoryIds(): string[] {
  return [...library.values()]
    .filter((e) => e.playCount > 0 && (e.source === "youtube" || !!e.savedFilePath))
    .map((e) => e.id);
}

export function listHistory(viewerName?: string, limit = 50): LibraryTrackSummary[] {
  return [...library.values()]
    .filter((e) => e.playCount > 0) // exclude upload placeholders that haven't actually played yet (see registerUpload)
    .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
    .slice(0, limit)
    .map((e) => summarize(e, viewerName));
}

export function listMostLiked(viewerName?: string, limit = 50): LibraryTrackSummary[] {
  return [...library.values()]
    .filter((e) => e.likes.length > 0 && (e.source === "youtube" || !!e.savedFilePath))
    .sort((a, b) => b.likes.length - a.likes.length || b.lastPlayedAt - a.lastPlayedAt)
    .slice(0, limit)
    .map((e) => summarize(e, viewerName));
}

export function listMostPlayed(viewerName?: string, limit = 50): LibraryTrackSummary[] {
  return [...library.values()]
    .filter((e) => e.playCount > 0)
    .sort((a, b) => b.playCount - a.playCount || b.lastPlayedAt - a.lastPlayedAt)
    .slice(0, limit)
    .map((e) => summarize(e, viewerName));
}

export function listSavedUploads(viewerName?: string, limit = 50): LibraryTrackSummary[] {
  return [...library.values()]
    .filter((e) => e.source === "upload" && !!e.savedFilePath)
    .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
    .slice(0, limit)
    .map((e) => summarize(e, viewerName));
}
