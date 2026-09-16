import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractYouTubePlaylistId } from "./youtube";

export const STATIONS_DIR = path.join(import.meta.dir, "..", "data", "stations");

export interface Track {
  title: string;
  path: string;
}

export interface Station {
  slug: string;
  name: string;
  tracks: Track[];
  virtual?: boolean;
}

export const ALL_STATION_SLUG = "master";

// Non-playable placeholder used for the divider entries in the "All
// Stations" playlist, so a header like "---- Chill Radio ----" shows up as
// a real, clickable-but-inert list entry between each station's tracks.
//
// NOTE: this must be a URL a player will actually accept as a track entry.
// "about:blank" looked right but isn't a real http(s) URL, so cliamp's M3U
// parser was silently dropping those entries entirely instead of showing
// them as dead tracks. ".invalid" is a TLD reserved by RFC 2606 to always
// fail to resolve, so this looks like a normal stream URL to any parser but
// is guaranteed to error out immediately if actually played.
const HEADER_PLACEHOLDER_URL = "https://cliamp-radio.invalid/divider";

function isHeaderTrack(track: Track): boolean {
  return track.path === HEADER_PLACEHOLDER_URL;
}

function stationHeader(name: string): Track {
  const bar = "-".repeat(16);
  return { title: `${bar} ${name} ${bar}`, path: HEADER_PLACEHOLDER_URL };
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function isReservedSlug(slug: string): boolean {
  return slug === ALL_STATION_SLUG;
}

async function ensureDir() {
  await mkdir(STATIONS_DIR, { recursive: true });
}

async function listRealStations(): Promise<Station[]> {
  await ensureDir();
  const files = (await readdir(STATIONS_DIR)).filter((f) => f.endsWith(".json"));
  const stations = await Promise.all(
    files.map(async (file) => {
      const raw = await readFile(path.join(STATIONS_DIR, file), "utf-8");
      return JSON.parse(raw) as Station;
    })
  );
  return stations.sort((a, b) => a.name.localeCompare(b.name));
}

function buildAllStation(stations: Station[]): Station {
  const seen = new Set<string>();
  const tracks: Track[] = [];
  for (const station of stations) {
    const grouped: Track[] = [];
    for (const track of station.tracks) {
      if (isHeaderTrack(track) || seen.has(track.path)) continue;
      seen.add(track.path);
      grouped.push(track);
    }
    if (grouped.length === 0) continue; // nothing new from this station — skip its header too
    tracks.push(stationHeader(station.name), ...grouped);
  }
  return { slug: ALL_STATION_SLUG, name: "Master Station", tracks, virtual: true };
}

export async function listStations(): Promise<Station[]> {
  const stations = await listRealStations();
  return [buildAllStation(stations), ...stations];
}

export async function getStation(slug: string): Promise<Station | null> {
  if (slug === ALL_STATION_SLUG) {
    return buildAllStation(await listRealStations());
  }
  await ensureDir();
  try {
    const raw = await readFile(path.join(STATIONS_DIR, `${slug}.json`), "utf-8");
    return JSON.parse(raw) as Station;
  } catch {
    return null;
  }
}

export async function saveStation(station: Station): Promise<Station> {
  const slug = slugify(station.name);
  if (isReservedSlug(slug)) {
    throw new Error(`"${station.name}" is a reserved station name`);
  }
  await ensureDir();
  const toSave: Station = { slug, name: station.name, tracks: station.tracks };
  await writeFile(
    path.join(STATIONS_DIR, `${slug}.json`),
    JSON.stringify(toSave, null, 2)
  );
  return toSave;
}

export async function deleteStation(slug: string): Promise<boolean> {
  if (isReservedSlug(slug)) return false;
  await ensureDir();
  try {
    await rm(path.join(STATIONS_DIR, `${slug}.json`));
    return true;
  } catch {
    return false;
  }
}

/**
 * Renders a station as an M3U playlist. Any track whose `path` is a YouTube
 * playlist link (a "Radio" mix or a saved playlist — anything with a
 * `list=` param) is rewritten to point at this server's own `/live/`
 * endpoint instead of the raw YouTube URL. That endpoint is a single,
 * always-on, shuffled-and-looping radio stream with ICY metadata, so
 * everyone tuning in to that track hears the same thing at the same time —
 * instead of each listener's player independently restarting the playlist
 * from track one via yt-dlp/YouTube itself.
 */
export function renderM3U(station: Station, baseUrl: string): string {
  const lines = ["#EXTM3U", `#PLAYLIST:${station.name}`];
  for (const track of station.tracks) {
    const playlistId = extractYouTubePlaylistId(track.path);
    const path = playlistId ? `${baseUrl}/cliamp-radio/live/${playlistId}.mp3` : track.path;
    lines.push(`#EXTINF:-1,${track.title}`, path);
  }
  return lines.join("\n") + "\n";
}
