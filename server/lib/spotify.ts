const SPOTIFY_HOSTNAMES = /(^|\.)open\.spotify\.com$/;
const SPOTIFY_TRACK_PATH_RE = /^\/(?:intl-[a-z]{2}\/)?track\/([a-zA-Z0-9]+)/;

/**
 * Detects a Spotify track share link (e.g.
 * https://open.spotify.com/track/<id>?si=... or the localized
 * /intl-xx/track/<id> form) and extracts the track ID, or null for
 * anything else (playlists, albums, non-Spotify URLs, etc.).
 */
export function extractSpotifyTrackId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!SPOTIFY_HOSTNAMES.test(parsed.hostname)) return null;
  const m = parsed.pathname.match(SPOTIFY_TRACK_PATH_RE);
  return m ? m[1]! : null;
}

/**
 * Resolves a Spotify track link to a "<artists> <title>" search string by
 * scraping the track page's meta tags — no Spotify Web API auth needed.
 * The real track title comes from `og:title`; the artist(s) come from the
 * first segment of `og:description`, which Spotify renders server-side as
 * "Artist1, Artist2 · Album · Song · Year" (note: the second segment is the
 * *album* name, not the track title — e.g. it can differ from the song
 * itself for anything but a single, so it must not be used as the title).
 * Returns null if the page can't be fetched or doesn't have the expected
 * shape.
 */
export async function resolveSpotifyTrackQuery(trackId: string): Promise<string | null> {
  const res = await fetch(`https://open.spotify.com/track/${trackId}`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; cliamp-radio)" },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const descMatch = html.match(/<meta property="og:description" content="([^"]*)"/);
  const titleMatch = html.match(/<meta property="og:title" content="([^"]*)"/);
  if (!descMatch || !titleMatch) return null;
  const [artists] = descMatch[1]!.split(" · ");
  const title = titleMatch[1]!;
  if (!artists || !title) return null;
  const decoded = (s: string) =>
    s
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  return `${decoded(artists)} ${decoded(title)}`.trim();
}
