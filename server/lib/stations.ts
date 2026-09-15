import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const STATIONS_DIR = path.join(import.meta.dir, "..", "data", "stations");

export interface Track {
  title: string;
  path: string;
}

export interface Station {
  slug: string;
  name: string;
  tracks: Track[];
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function ensureDir() {
  await mkdir(STATIONS_DIR, { recursive: true });
}

export async function listStations(): Promise<Station[]> {
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

export async function getStation(slug: string): Promise<Station | null> {
  await ensureDir();
  try {
    const raw = await readFile(path.join(STATIONS_DIR, `${slug}.json`), "utf-8");
    return JSON.parse(raw) as Station;
  } catch {
    return null;
  }
}

export async function saveStation(station: Station): Promise<Station> {
  await ensureDir();
  const slug = slugify(station.name);
  const toSave: Station = { ...station, slug };
  await writeFile(
    path.join(STATIONS_DIR, `${slug}.json`),
    JSON.stringify(toSave, null, 2)
  );
  return toSave;
}

export async function deleteStation(slug: string): Promise<boolean> {
  await ensureDir();
  try {
    await rm(path.join(STATIONS_DIR, `${slug}.json`));
    return true;
  } catch {
    return false;
  }
}

export function renderM3U(station: Station): string {
  const lines = ["#EXTM3U", `#PLAYLIST:${station.name}`];
  for (const track of station.tracks) {
    lines.push(`#EXTINF:-1,${track.title}`, track.path);
  }
  return lines.join("\n") + "\n";
}
