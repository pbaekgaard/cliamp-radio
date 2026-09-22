import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { drainText, extractYouTubeVideoId, YTDLP_COOKIE_ARGS, YTDLP_EXTRA_ARGS } from "./youtube";

// ---------------------------------------------------------------------------
// Admin-uploaded mp3 files that WorkFM's auto-DJ (see workfmQueue.ts's
// loop()) automatically weaves in between real tracks: "announcement" files
// play solo every ANNOUNCEMENT_INTERVAL_MS of actual playback time, and "ad"
// files play in a batch of AD_BREAK_FILE_COUNT every AD_BREAK_INTERVAL_MS.
// Both categories share the same on-disk store (server/data/workfm-
// announcements/) and a small JSON index — the same pattern as
// workfmLibrary.ts's saved uploads, just simpler (no TTL/likes/play-count
// tracking needed here).
// ---------------------------------------------------------------------------

export type AnnouncementCategory = "announcement" | "ad";

export interface AnnouncementFile {
  id: string;
  category: AnnouncementCategory;
  /** Shown only in the admin dashboard's file list — listeners always see
   * the fixed "ANNOUNCEMENT"/"ADVERTISEMENT" label instead (see
   * workfmQueue.ts's playSpecial()). */
  title: string;
  /** On-disk filename within DATA_DIR (not a full path). */
  filename: string;
  uploadedAt: number;
}

const DATA_DIR = path.join(import.meta.dir, "..", "data", "workfm-announcements");
const INDEX_PATH = path.join(DATA_DIR, "index.json");

async function ensureDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

async function readIndex(): Promise<AnnouncementFile[]> {
  await ensureDir();
  try {
    return JSON.parse(await readFile(INDEX_PATH, "utf-8")) as AnnouncementFile[];
  } catch {
    return [];
  }
}

async function writeIndex(entries: AnnouncementFile[]) {
  await ensureDir();
  await writeFile(INDEX_PATH, JSON.stringify(entries, null, 2));
}

export function announcementFilePath(entry: AnnouncementFile): string {
  return path.join(DATA_DIR, entry.filename);
}

export async function listAnnouncementFiles(category?: AnnouncementCategory): Promise<AnnouncementFile[]> {
  const all = await readIndex();
  const filtered = category ? all.filter((e) => e.category === category) : all;
  return filtered.sort((a, b) => b.uploadedAt - a.uploadedAt);
}

export async function saveAnnouncementFile(
  category: AnnouncementCategory,
  file: File,
  title?: string
): Promise<AnnouncementFile> {
  const looksLikeMp3 = /\.mp3$/i.test(file.name || "") || file.type === "audio/mpeg" || file.type === "audio/mp3";
  if (!looksLikeMp3) throw new Error("only .mp3 files are supported");
  if (file.size <= 0) throw new Error("that file looks empty");

  await ensureDir();
  const id = crypto.randomUUID();
  const filename = `${id}.mp3`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await writeFile(path.join(DATA_DIR, filename), bytes);

  const fallbackTitle = (file.name || "").replace(/\.[^./]+$/, "").trim();
  const entry: AnnouncementFile = {
    id,
    category,
    title: title?.trim() || fallbackTitle || (category === "ad" ? "Advertisement" : "Announcement"),
    filename,
    uploadedAt: Date.now(),
  };

  const all = await readIndex();
  all.push(entry);
  await writeIndex(all);
  return entry;
}

/**
 * Downloads a YouTube video's audio track straight to an mp3 in DATA_DIR
 * (via yt-dlp's `-x --audio-format mp3`, same extraction yt-dlp already
 * does elsewhere in this app) and registers it the same as an uploaded
 * file — lets an admin paste a link instead of downloading a video
 * themselves just to re-upload its audio.
 */
export async function saveAnnouncementFromYouTube(
  category: AnnouncementCategory,
  url: string,
  title?: string
): Promise<AnnouncementFile> {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) throw new Error("that doesn't look like a YouTube video link");
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  await ensureDir();
  const id = crypto.randomUUID();
  const filename = `${id}.mp3`;
  // `-o` uses %(ext)s rather than a fixed ".mp3" because yt-dlp only renames
  // to the target extension *after* the audio-extraction postprocessor
  // finishes — the id is ours (a fresh UUID), so the final path is
  // deterministic either way.
  const outputTemplate = path.join(DATA_DIR, `${id}.%(ext)s`);

  const proc = Bun.spawn(
    [
      "yt-dlp",
      ...YTDLP_COOKIE_ARGS,
      ...YTDLP_EXTRA_ARGS,
      "-x",
      "--audio-format",
      "mp3",
      "--no-playlist",
      "--quiet",
      "--no-warnings",
      // Printed only after the file's been moved to its final post-
      // extraction name, so this reflects the actual finished mp3.
      "--print",
      "after_move:%(title)s\t%(uploader)s",
      "-o",
      outputTemplate,
      videoUrl,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), drainText(proc.stderr)]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`failed to download audio from YouTube${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
  }

  const finalPath = path.join(DATA_DIR, filename);
  if (!(await Bun.file(finalPath).exists())) {
    throw new Error("download finished but the mp3 file wasn't found — the video may be unavailable");
  }

  const [rawTitle] = (stdout.split("\n")[0] ?? "").split("\t");
  const entry: AnnouncementFile = {
    id,
    category,
    title: title?.trim() || rawTitle?.trim() || (category === "ad" ? "Advertisement" : "Announcement"),
    filename,
    uploadedAt: Date.now(),
  };

  const all = await readIndex();
  all.push(entry);
  await writeIndex(all);
  return entry;
}

/**
 * Copies an existing on-disk mp3 (e.g. a WorkFM upload's still-saved file —
 * see workfmLibrary.ts's savedFilePath) into DATA_DIR as a new announcement/
 * ad entry, without re-encoding or re-downloading anything. Used by the
 * admin dashboard's "Mark as ad"/"Mark as announcement" actions on a
 * History entry, so a track that's already been uploaded once doesn't need
 * to be re-uploaded just to promote it.
 */
export async function saveAnnouncementFromDisk(
  category: AnnouncementCategory,
  sourceFilePath: string,
  title?: string
): Promise<AnnouncementFile> {
  await ensureDir();
  const id = crypto.randomUUID();
  const filename = `${id}.mp3`;
  await copyFile(sourceFilePath, path.join(DATA_DIR, filename));

  const entry: AnnouncementFile = {
    id,
    category,
    title: title?.trim() || (category === "ad" ? "Advertisement" : "Announcement"),
    filename,
    uploadedAt: Date.now(),
  };

  const all = await readIndex();
  all.push(entry);
  await writeIndex(all);
  return entry;
}

export async function deleteAnnouncementFile(id: string): Promise<boolean> {
  const all = await readIndex();
  const idx = all.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  const [removed] = all.splice(idx, 1);
  await writeIndex(all);
  if (removed) {
    try {
      await rm(announcementFilePath(removed), { force: true });
    } catch {
      // best-effort — an orphaned file on disk is harmless
    }
  }
  return true;
}

/** Picks up to `count` distinct random files from `category` — fewer than
 * `count` (or none) if the category doesn't have enough uploads yet. */
export async function pickRandomAnnouncementFiles(
  category: AnnouncementCategory,
  count: number
): Promise<AnnouncementFile[]> {
  const pool = await listAnnouncementFiles(category);
  if (pool.length === 0) return [];
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled.slice(0, count);
}
