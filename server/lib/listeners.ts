import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import geoip from "geoip-lite";

const DATA_DIR = path.join(import.meta.dir, "..", "data");
const HISTORY_PATH = path.join(DATA_DIR, "listen-history.jsonl");
const MAX_HISTORY_LINES = 20000; // enough for months of a small self-hosted server; keeps stats fast to compute

interface Listen {
  ip: string;
  station: string;
  stationName: string;
  lat: number;
  lng: number;
  city: string;
  countryCode: string;
  firstSeen: number;
  timestamp: number; // last seen
}

interface HistoryEntry {
  station: string;
  stationName: string;
  countryCode: string;
  city: string;
  lat: number;
  lng: number;
  startedAt: number;
  endedAt: number;
}

const TTL_MS = 10 * 60 * 1000; // a listener is considered "active" for 10 minutes after their last request
const listens = new Map<string, Listen>();

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
function countryName(code: string): string {
  if (!code || code === "Unknown") return "Unknown";
  try {
    return regionNames.of(code) || code;
  } catch {
    return code;
  }
}

function normalizeIp(ip: string): string {
  // Strip IPv6-mapped IPv4 prefix
  return ip.replace(/^::ffff:/, "");
}

function appendHistory(entry: HistoryEntry) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(HISTORY_PATH, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.log(`[listeners] failed to persist listen history: ${err}`);
  }
}

function finalizeSession(listen: Listen) {
  appendHistory({
    station: listen.station,
    stationName: listen.stationName,
    countryCode: listen.countryCode,
    city: listen.city,
    lat: listen.lat,
    lng: listen.lng,
    startedAt: listen.firstSeen,
    endedAt: listen.timestamp,
  });
}

function readHistory(): HistoryEntry[] {
  try {
    if (!existsSync(HISTORY_PATH)) return [];
    const lines = readFileSync(HISTORY_PATH, "utf8").split("\n").filter(Boolean);
    const tail = lines.slice(-MAX_HISTORY_LINES);
    const entries: HistoryEntry[] = [];
    for (const line of tail) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip a corrupted line rather than fail the whole read
      }
    }
    return entries;
  } catch (err) {
    console.log(`[listeners] failed to read listen history: ${err}`);
    return [];
  }
}

// Sweep expired sessions out of the active map, persisting each one to the
// history log on the way out so all-time stats (sessions, hours, top
// countries) stay accurate even after a listener stops polling.
function sweepExpired() {
  const now = Date.now();
  for (const [ip, listen] of listens) {
    if (now - listen.timestamp > TTL_MS) {
      finalizeSession(listen);
      listens.delete(ip);
    }
  }
}

setInterval(sweepExpired, 60 * 1000).unref?.();

export function recordListen(rawIp: string, station: string, stationName: string) {
  const ip = normalizeIp(rawIp);
  const now = Date.now();
  const existing = listens.get(ip);

  let lat: number;
  let lng: number;
  let city = "Unknown";
  let countryCode = "Unknown";

  const geo = geoip.lookup(ip);
  if (geo) {
    [lat, lng] = geo.ll;
    city = geo.city || "Unknown";
    countryCode = geo.country || "Unknown";
  } else {
    // Private/local/unresolvable IP (e.g. testing from localhost, a LAN, or
    // a VPN/CGNAT range geoip-lite has no data for) — scatter around null
    // island a little so several such listeners don't render as one dot.
    lat = (Math.random() - 0.5) * 8;
    lng = (Math.random() - 0.5) * 8;
    console.log(`[listeners] no geoip data for ${ip} — plotting near (0,0) as a fallback`);
  }

  if (existing && existing.station !== station) {
    // Switched stations — the old session is over, log it before starting a new one.
    finalizeSession(existing);
  }

  listens.set(ip, {
    ip,
    station,
    stationName,
    lat,
    lng,
    city,
    countryCode,
    firstSeen: existing && existing.station === station ? existing.firstSeen : now,
    timestamp: now,
  });
  console.log(`[listeners] recorded ${ip} -> ${station} (${city}, ${countryCode} @ ${lat.toFixed(2)},${lng.toFixed(2)})`);
}

export function activeListens(): Array<Omit<Listen, "ip" | "countryCode"> & { country: string }> {
  sweepExpired();
  const result: Array<Omit<Listen, "ip" | "countryCode"> & { country: string }> = [];
  for (const listen of listens.values()) {
    const { ip: _drop, countryCode, ...rest } = listen;
    result.push({ ...rest, country: countryCode });
  }
  return result;
}

interface CountryCount {
  code: string;
  name: string;
  count: number;
}

interface StationCount {
  slug: string;
  name: string;
  count: number;
}

function topCountries(rows: Array<{ countryCode: string }>, limit = 10): CountryCount[] {
  const byCode = new Map<string, number>();
  for (const r of rows) {
    if (!r.countryCode || r.countryCode === "Unknown") continue;
    byCode.set(r.countryCode, (byCode.get(r.countryCode) || 0) + 1);
  }
  return [...byCode.entries()]
    .map(([code, count]) => ({ code, name: countryName(code), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function busiestStation(rows: Array<{ station: string; stationName: string }>): StationCount | null {
  const byStation = new Map<string, StationCount>();
  for (const r of rows) {
    const existing = byStation.get(r.station);
    if (existing) existing.count += 1;
    else byStation.set(r.station, { slug: r.station, name: r.stationName, count: 1 });
  }
  let best: StationCount | null = null;
  for (const s of byStation.values()) {
    if (!best || s.count > best.count) best = s;
  }
  return best;
}

export interface LiveStats {
  listeners: number;
  countries: number;
  topCountries: CountryCount[];
  busiestStation: StationCount | null;
}

export function getLiveStats(): LiveStats {
  sweepExpired();
  const rows = [...listens.values()];
  return {
    listeners: rows.length,
    countries: new Set(rows.map((r) => r.countryCode).filter((c) => c && c !== "Unknown")).size,
    topCountries: topCountries(rows),
    busiestStation: busiestStation(rows),
  };
}

export interface AllTimeStats {
  totalSessions: number;
  totalListenHours: number;
  peakListeners: number;
  topCountries: CountryCount[];
  busiestStation: StationCount | null;
  daily: Array<{ date: string; hours: number }>;
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function getAllTimeStats(): AllTimeStats {
  sweepExpired();
  const history = readHistory();
  const now = Date.now();
  const active = [...listens.values()];

  // Ongoing sessions count toward totals too, using elapsed time so far.
  const combinedRows = [
    ...history.map((h) => ({ countryCode: h.countryCode, station: h.station, stationName: h.stationName })),
    ...active.map((a) => ({ countryCode: a.countryCode, station: a.station, stationName: a.stationName })),
  ];

  let totalHoursMs = 0;
  for (const h of history) totalHoursMs += Math.max(0, h.endedAt - h.startedAt);
  for (const a of active) totalHoursMs += Math.max(0, now - a.firstSeen);

  const dailyMap = new Map<string, number>();
  for (const h of history) {
    const hours = Math.max(0, h.endedAt - h.startedAt) / 3600000;
    const key = dayKey(h.startedAt);
    dailyMap.set(key, (dailyMap.get(key) || 0) + hours);
  }
  for (const a of active) {
    const hours = Math.max(0, now - a.firstSeen) / 3600000;
    const key = dayKey(a.firstSeen);
    dailyMap.set(key, (dailyMap.get(key) || 0) + hours);
  }
  const cutoff = now - 31 * 24 * 60 * 60 * 1000;
  const daily = [...dailyMap.entries()]
    .filter(([key]) => new Date(key).getTime() >= cutoff)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, hours]) => ({ date, hours }));

  // Peak concurrent listeners isn't tracked precisely (we only sample on
  // demand), so approximate it as the largest single-day session count as a
  // reasonable stand-in until we have real point-in-time sampling.
  const dailyCounts = new Map<string, number>();
  for (const h of history) dailyCounts.set(dayKey(h.startedAt), (dailyCounts.get(dayKey(h.startedAt)) || 0) + 1);
  for (const a of active) dailyCounts.set(dayKey(a.firstSeen), (dailyCounts.get(dayKey(a.firstSeen)) || 0) + 1);
  const peakListeners = Math.max(active.length, ...(dailyCounts.size ? [...dailyCounts.values()] : [0]));

  return {
    totalSessions: history.length + active.length,
    totalListenHours: totalHoursMs / 3600000,
    peakListeners,
    topCountries: topCountries(combinedRows),
    busiestStation: busiestStation(combinedRows),
    daily,
  };
}
