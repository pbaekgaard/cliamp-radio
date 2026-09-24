import { useEffect, useState } from "react";

/** A single BetterTTV global emote. */
export type BttvEmote = {
  id: string;
  name: string;
  animated: boolean;
  url: string;
};

type BttvApiEmote = {
  id: string;
  code: string;
  imageType: string;
  animated: boolean;
};

// BetterTTV's public API is free, no auth, and CORS-open (reflects the
// request's Origin). Its "global" set is small but covers most of the
// actually-famous, no-channel-required emote culture classics — monkaS,
// LuL, FeelsBadMan/FeelsGoodMan, KKona, etc. — that 7TV's own curated
// "global" set (see lib/sevenTv.ts) mostly doesn't include, since those
// are usually added per-channel via the 7TV browser extension rather than
// being part of the platform-wide default set.
const GLOBAL_EMOTES_URL = "https://api.betterttv.net/3/cached/emotes/global";

const CACHE_KEY = "bttvGlobalEmotesV1";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — emote sets rarely change

let memoryCache: Map<string, BttvEmote> | null = null;
let inflight: Promise<Map<string, BttvEmote>> | null = null;

function emoteImageUrl(id: string): string {
  return `https://cdn.betterttv.net/emote/${id}/3x`;
}

function readCache(): Map<string, BttvEmote> | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      ts: number;
      entries: [string, BttvEmote][];
    };
    if (Date.now() - parsed.ts > CACHE_TTL_MS) return null;
    return new Map(parsed.entries);
  } catch {
    return null;
  }
}

function writeCache(map: Map<string, BttvEmote>) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ ts: Date.now(), entries: [...map.entries()] })
    );
  } catch {
    // best-effort — a full/disabled localStorage just means re-fetching
  }
}

async function fetchGlobalEmotes(): Promise<Map<string, BttvEmote>> {
  const res = await fetch(GLOBAL_EMOTES_URL);
  if (!res.ok) throw new Error(`BTTV fetch failed: ${res.status}`);
  const body = (await res.json()) as BttvApiEmote[];
  const map = new Map<string, BttvEmote>();
  for (const raw of body) {
    map.set(raw.code, {
      id: raw.id,
      name: raw.code,
      animated: raw.animated,
      url: emoteImageUrl(raw.id),
    });
  }
  return map;
}

/** Fetches (and caches, in-memory + localStorage) BTTV's global emote set.
 * Safe to call repeatedly — concurrent calls share one in-flight request. */
export async function getBttvGlobalEmotes(): Promise<Map<string, BttvEmote>> {
  if (memoryCache) return memoryCache;
  if (!inflight) {
    inflight = (async () => {
      const cached = readCache();
      if (cached) {
        memoryCache = cached;
        return cached;
      }
      const map = await fetchGlobalEmotes();
      memoryCache = map;
      writeCache(map);
      return map;
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** Loads BTTV's global emote set on mount; returns null until it's ready
 * (or if the fetch fails, in which case chat just renders plain text). */
export function useBttvGlobalEmotes(): Map<string, BttvEmote> | null {
  const [emotes, setEmotes] = useState<Map<string, BttvEmote> | null>(
    memoryCache
  );

  useEffect(() => {
    if (emotes) return;
    let cancelled = false;
    getBttvGlobalEmotes()
      .then((map) => {
        if (!cancelled) setEmotes(map);
      })
      .catch(() => {
        // best-effort — chat still works without emotes
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return emotes;
}
