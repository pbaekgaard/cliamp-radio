// Mirrors server/lib/youtube.ts's extractYouTubePlaylistId — used here only
// to figure out, client-side, which station tracks are YouTube playlists
// (so we know which ones to fetch a live listener count for), not to do any
// actual stream handling.
const PLAYLIST_ID_RE = /[?&]list=([a-zA-Z0-9_-]+)/;
const YT_HOSTNAMES = /(^|\.)youtube\.com$|(^|\.)music\.youtube\.com$|(^|\.)youtu\.be$/;

// Mirrors server/lib/stations.ts's DEIF_QUEUE_MARKER — the special track
// path for the DEIF FM queue channel, rewritten to a dedicated live stream
// endpoint rather than resolved as a normal YouTube URL.
const DEIF_QUEUE_MARKER = "deif-fm://queue";

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

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

// Mirrors server/lib/youtube.ts's extractYouTubeVideoId — used to figure
// out which tracks (playlist or plain video links alike) can be tuned into
// live in the browser via the server's on-demand `/live/video/<id>.mp3`
// endpoint, without needing a `list=` playlist param.
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
 * Resolves the browser-playable live-stream URL for a track, whether it's a
 * YouTube playlist link (shares the same always-on channel stream as the
 * .m3u output), a plain single-video link (lazily transcoded on demand,
 * web-only — never referenced by any station's .m3u), or DEIF FM's queue
 * marker. Returns null for tracks with no resolvable stream.
 */
export function tuneInUrlForTrack(path: string): string | null {
  if (path === DEIF_QUEUE_MARKER) return "/cliamp-radio/live/deif-fm.mp3";
  const playlistId = extractYouTubePlaylistId(path);
  if (playlistId) return `/cliamp-radio/live/${playlistId}.mp3`;
  const videoId = extractYouTubeVideoId(path);
  if (videoId) return `/cliamp-radio/live/video/${videoId}.mp3`;
  return null;
}
