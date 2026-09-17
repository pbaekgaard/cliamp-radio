const PLAYLIST_ID_RE = /[?&]list=([a-zA-Z0-9_-]+)/;
const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const YT_HOSTNAMES = /(^|\.)youtube\.com$|(^|\.)music\.youtube\.com$|(^|\.)youtu\.be$/;

// YouTube increasingly blocks requests from datacenter/VPS IPs with "Sign in
// to confirm you're not a bot" unless yt-dlp presents cookies from a real,
// signed-in browser session. Two ways to supply them, checked in this order
// (shared by every yt-dlp invocation across the server — playlist streaming
// and the DEIF FM queue alike):
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
