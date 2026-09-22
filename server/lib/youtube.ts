const PLAYLIST_ID_RE = /[?&]list=([a-zA-Z0-9_-]+)/;
const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const YT_HOSTNAMES = /(^|\.)youtube\.com$|(^|\.)music\.youtube\.com$|(^|\.)youtu\.be$/;

// YouTube increasingly blocks requests from datacenter/VPS IPs with "Sign in
// to confirm you're not a bot" unless yt-dlp presents cookies from a real,
// signed-in browser session. Two ways to supply them, checked in this order
// (shared by every yt-dlp invocation across the server — playlist streaming
// and the WorkFM queue alike):
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
export const YTDLP_COOKIE_ARGS = YTDLP_COOKIES_FROM_BROWSER
  ? ["--cookies-from-browser", YTDLP_COOKIES_FROM_BROWSER]
  : YTDLP_COOKIES_FILE
    ? ["--cookies", YTDLP_COOKIES_FILE]
    : [];

// yt-dlp increasingly needs to solve a JS "signature"/"n" challenge to get
// playable URLs at all (independent of cookies/bot-detection above) — when
// installed via pip/apt (as opposed to yt-dlp's own standalone release
// build) it won't auto-fetch the solver component unless explicitly
// allowed here. Requires a JS runtime on PATH too (Deno; see README).
// Harmless/no-op if a bundled solver is already present.
export const YTDLP_EXTRA_ARGS = ["--remote-components", "ejs:github"];

const MAX_STDERR_CHARS = 4000; // cap so a runaway/looping process can't bloat memory or logs

/**
 * Reads an entire stderr stream to text, bounded so a chatty or runaway
 * process can't grow unbounded in memory. Used purely for error reporting
 * when a subprocess fails — normal/successful runs never have this text
 * looked at.
 */
export async function drainText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  try {
    const text = await new Response(stream).text();
    return text.length > MAX_STDERR_CHARS ? `…${text.slice(-MAX_STDERR_CHARS)}` : text;
  } catch {
    return "";
  }
}

/**
 * Extracts an 11-char YouTube video ID from any watch/youtu.be/shorts URL.
 * Returns null for playlist-only links or non-YouTube URLs.
 */
export function extractYouTubeVideoId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!YT_HOSTNAMES.test(parsed.hostname)) return null;
  if (parsed.hostname.replace(/^www\./, "") === "youtu.be") {
    const id = parsed.pathname.slice(1);
    return VIDEO_ID_RE.test(id) ? id : null;
  }
  const vParam = parsed.searchParams.get("v");
  if (vParam && VIDEO_ID_RE.test(vParam)) return vParam;
  const shortsMatch = parsed.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
  if (shortsMatch) return shortsMatch[1]!;
  return null;
}

/**
 * Extracts the YouTube playlist ID from any watch/playlist/music URL that
 * carries a `list=` query param (e.g. a "Radio" mix or a saved playlist).
 * Returns null for plain video links (no playlist) or non-YouTube URLs, in
 * which case the track's path is left untouched and streamed as-is.
 */
export function extractYouTubePlaylistId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!YT_HOSTNAMES.test(parsed.hostname)) return null;
  const m = url.match(PLAYLIST_ID_RE);
  return m ? m[1]! : null;
}

/**
 * Splits a YouTube video title into a best-effort {artist, title}, for the
 * ICY "now playing" metadata. Most music uploads follow "Artist - Title"
 * (sometimes with extra dashes in the title itself, e.g.
 * "Artist - Title - Live"), so we only split on the *first* " - ". Falls
 * back to the uploader/channel name as the artist when there's no dash to
 * split on.
 */
export function parseArtistTitle(
  rawTitle: string,
  uploader: string | null
): { artist: string; title: string } {
  const idx = rawTitle.indexOf(" - ");
  if (idx > 0) {
    return { artist: rawTitle.slice(0, idx).trim(), title: rawTitle.slice(idx + 3).trim() };
  }
  return { artist: uploader?.trim() || "Unknown Artist", title: rawTitle.trim() };
}

export interface YouTubeSearchResult {
  videoId: string;
  title: string;
  uploader: string | null;
  durationSec?: number;
  thumbnail?: string;
}

const MAX_SEARCH_RESULTS = 20; // sane upper bound regardless of what a caller asks for

/**
 * Runs a YouTube search via yt-dlp's `ytsearchN:` pseudo-URL and returns
 * lightweight metadata (no download, no format resolution) for the WorkFM
 * "search instead of pasting a link" UI. `--flat-playlist` keeps this fast —
 * each result comes straight from the search results page rather than a
 * full per-video fetch.
 */
export async function searchYouTube(query: string, limit = 8): Promise<YouTubeSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const count = Math.max(1, Math.min(limit, MAX_SEARCH_RESULTS));
  return runYtDlpSearch([`ytsearch${count}:${trimmed}`], { flat: true });
}

/**
 * Same idea as `searchYouTube`, but searches YouTube *Music*'s "Songs"
 * section instead of general YouTube video search. This is used for
 * Spotify-link lookups, where we already know we want the official song
 * audio rather than whatever video (lyric videos, covers, reactions, live
 * performances, ...) a plain YouTube search might surface first.
 * `--playlist-items 1-N` caps how many of YT Music's (often hundreds of)
 * search results yt-dlp has to paginate through, keeping this fast. Uses
 * `--flat-playlist` for speed — flat results only expose the *channel*
 * name (not the real per-track artist credit), so callers with a known
 * artist (e.g. resolved from the source Spotify link) should override the
 * `uploader` field on the results themselves rather than trusting this.
 */
export async function searchYouTubeMusic(query: string, limit = 8): Promise<YouTubeSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const count = Math.max(1, Math.min(limit, MAX_SEARCH_RESULTS));
  const searchUrl = `https://music.youtube.com/search?q=${encodeURIComponent(trimmed)}#Songs`;
  return runYtDlpSearch([searchUrl, "--playlist-items", `1-${count}`], { flat: true });
}

async function runYtDlpSearch(targetArgs: string[], opts: { flat: boolean }): Promise<YouTubeSearchResult[]> {
  const proc = Bun.spawn(
    [
      "yt-dlp",
      ...YTDLP_COOKIE_ARGS,
      ...YTDLP_EXTRA_ARGS,
      ...targetArgs,
      ...(opts.flat ? ["--flat-playlist"] : []),
      "--skip-download",
      "-j",
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    drainText(proc.stderr),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`yt-dlp search failed${stderr ? `: ${stderr}` : ""}`);
  }
  const results: YouTubeSearchResult[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry.id !== "string" || !VIDEO_ID_RE.test(entry.id)) continue;
      const thumbnails = Array.isArray(entry.thumbnails) ? entry.thumbnails : [];
      const thumbnail = thumbnails.length ? thumbnails[thumbnails.length - 1]?.url : undefined;
      // Full (non-flat) metadata carries the real artist credit as
      // "artist" (e.g. "Daft Punk, Pharrell Williams"), which is what we
      // want for YT Music results — flat results only have "channel"/
      // "uploader", which is often just the primary artist's channel name.
      const uploader =
        typeof entry.artist === "string"
          ? entry.artist
          : typeof entry.channel === "string"
            ? entry.channel
            : entry.uploader ?? null;
      results.push({
        videoId: entry.id,
        title: typeof entry.title === "string" ? entry.title : "Untitled",
        uploader,
        durationSec: typeof entry.duration === "number" ? entry.duration : undefined,
        thumbnail,
      });
    } catch {
      // skip malformed line — best-effort parsing of yt-dlp's JSON stream
    }
  }
  return results;
}
