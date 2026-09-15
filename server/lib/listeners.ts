import geoip from "geoip-lite";

interface Listen {
  ip: string;
  station: string;
  stationName: string;
  lat: number;
  lng: number;
  city: string;
  country: string;
  timestamp: number;
}

const TTL_MS = 3 * 60 * 1000; // a listener is considered "active" for 3 minutes after their last request
const listens = new Map<string, Listen>();

function normalizeIp(ip: string): string {
  // Strip IPv6-mapped IPv4 prefix
  return ip.replace(/^::ffff:/, "");
}

export function recordListen(rawIp: string, station: string, stationName: string) {
  const ip = normalizeIp(rawIp);
  let lat: number;
  let lng: number;
  let city = "Unknown";
  let country = "Unknown";

  const geo = geoip.lookup(ip);
  if (geo) {
    [lat, lng] = geo.ll;
    city = geo.city || "Unknown";
    country = geo.country || "Unknown";
  } else {
    // Private/local/unresolvable IP — jitter around null island so it still shows on the globe in dev.
    lat = 0;
    lng = 0;
  }

  listens.set(ip, {
    ip,
    station,
    stationName,
    lat,
    lng,
    city,
    country,
    timestamp: Date.now(),
  });
}

export function activeListens(): Omit<Listen, "ip">[] {
  const now = Date.now();
  const result: Omit<Listen, "ip">[] = [];
  for (const [ip, listen] of listens) {
    if (now - listen.timestamp > TTL_MS) {
      listens.delete(ip);
      continue;
    }
    const { ip: _drop, ...rest } = listen;
    result.push(rest);
  }
  return result;
}
