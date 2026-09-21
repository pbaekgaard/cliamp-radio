import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
export const SAVED_UPLOAD_TTL_MS = 60 * 24 * 60 * 60 * 1000; // ~2 months
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly is plenty for a multi-week TTL

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
  /** Upload-only: set while the file is retained on disk and requeueable;
   * cleared (by the retention sweep, or immediately if the uploader opted
   * out of saving) once it's gone — at which point it drops out of both
   * the "most liked" and "saved songs" views. */
  savedFilePath?: string;
  savedUntil?: number;
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
  savedUntil?: number;
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
    savedUntil: entry.savedUntil,
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

/** Ensures a library entry exists for `item` with playCount 0 — called the
 * moment an mp3 is uploaded (before it's necessarily played), so a saved
 * copy can be attached (see attachSavedUpload) and show up in "Saved
 * uploads" right away instead of waiting for its turn in the queue.
 * recordPlay() above still handles the *play-count* bookkeeping once it
 * actually plays — this only creates the placeholder entry if missing. */
export function registerUpload(item: PlayedTrack) {
  if (library.has(item.libraryId)) return;
  library.set(item.libraryId, {
    id: item.libraryId,
    source: item.source,
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
 * not just once it's finished playing. */
export function attachSavedUpload(libraryId: string, filePath: string, until: number) {
  const entry = library.get(libraryId);
  if (!entry) return;
  entry.savedFilePath = filePath;
  entry.savedUntil = until;
  save();
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
    .sort((a, b) => (b.savedUntil ?? 0) - (a.savedUntil ?? 0))
    .slice(0, limit)
    .map((e) => summarize(e, viewerName));
}

// Periodically deletes saved uploads past their TTL, and drops them out of
// the "most liked"/"saved songs" views (their library entry — and any
// likes/history — otherwise stays, just without a file to requeue).
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const entry of library.values()) {
    if (entry.source === "upload" && entry.savedFilePath && entry.savedUntil && entry.savedUntil <= now) {
      const filePath = entry.savedFilePath;
      entry.savedFilePath = undefined;
      entry.savedUntil = undefined;
      changed = true;
      rm(filePath, { force: true }).catch((err) =>
        console.error(`[workfm-library] failed to delete expired saved upload ${filePath}:`, err)
      );
    }
  }
  if (changed) save();
}, SWEEP_INTERVAL_MS).unref?.();
