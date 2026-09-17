// Mirrors server/lib/youtube.ts's extractYouTubePlaylistId — used here only
// to figure out, client-side, which station tracks are YouTube playlists
// (so we know which ones to fetch a live listener count for), not to do any
// actual stream handling.
const PLAYLIST_ID_RE = /[?&]list=([a-zA-Z0-9_-]+)/;
const YT_HOSTNAMES = /(^|\.)youtube\.com$|(^|\.)music\.youtube\.com$|(^|\.)youtu\.be$/;

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
