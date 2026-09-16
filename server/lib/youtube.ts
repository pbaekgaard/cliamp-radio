const PLAYLIST_ID_RE = /[?&]list=([a-zA-Z0-9_-]+)/;
const YT_HOSTNAMES = /(^|\.)youtube\.com$|(^|\.)music\.youtube\.com$|(^|\.)youtu\.be$/;

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
