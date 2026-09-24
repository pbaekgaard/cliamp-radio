import { useEffect, useState } from "react";

/** A single Twitch global emote, reduced down to what chat needs. */
export type TwitchEmote = {
  id: string;
  name: string;
  animated: boolean;
  url: string;
};

type IvrEmote = {
  code: string;
  id: string;
  assetType: "ANIMATED" | "STATIC";
};
type IvrEmoteSet = { setID: string; emoteList: IvrEmote[] };

// Twitch's own Helix "get global emotes" endpoint requires a Bearer app
// token (Client ID + Secret, minted server-side) — there's no way to call
// it directly from the browser without one. IVR (api.ivr.fi) is a free,
// no-auth, CORS-open community API that mirrors this same data (it's what
// several open-source Twitch chat clients use), so we go through that
// instead. Set ID "0" is Twitch's global emote set.
const GLOBAL_EMOTE_SET_URL = "https://api.ivr.fi/v2/twitch/emotes/sets?set_id=0";

const CACHE_KEY = "twitchGlobalEmotesV1";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — emote sets rarely change

let memoryCache: Map<string, TwitchEmote> | null = null;
let inflight: Promise<Map<string, TwitchEmote>> | null = null;

function emoteImageUrl(id: string): string {
  // "3.0" is the largest built-in size (~112px); dark background works
  // fine over the app's dark theme either way since most emotes have a
  // transparent background.
  return `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/3.0`;
}

function readCache(): Map<string, TwitchEmote> | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      ts: number;
      entries: [string, TwitchEmote][];
    };
    if (Date.now() - parsed.ts > CACHE_TTL_MS) return null;
    return new Map(parsed.entries);
  } catch {
    return null;
  }
}

function writeCache(map: Map<string, TwitchEmote>) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ ts: Date.now(), entries: [...map.entries()] })
    );
  } catch {
    // best-effort — a full/disabled localStorage just means re-fetching
  }
}

async function fetchGlobalEmotes(): Promise<Map<string, TwitchEmote>> {
  const res = await fetch(GLOBAL_EMOTE_SET_URL);
  if (!res.ok) throw new Error(`IVR fetch failed: ${res.status}`);
  const body = (await res.json()) as IvrEmoteSet[];
  const map = new Map<string, TwitchEmote>();
  for (const emote of body[0]?.emoteList ?? []) {
    map.set(emote.code, {
      id: emote.id,
      name: emote.code,
      animated: emote.assetType === "ANIMATED",
      url: emoteImageUrl(emote.id),
    });
  }
  return map;
}

/** Fetches (and caches, in-memory + localStorage) Twitch's global emote
 * set via IVR. Safe to call repeatedly — concurrent calls share one
 * in-flight request. */
export async function getTwitchGlobalEmotes(): Promise<
  Map<string, TwitchEmote>
> {
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

/** Loads Twitch's global emote set on mount; returns null until it's ready
 * (or if the fetch fails, in which case chat just renders plain text). */
export function useTwitchGlobalEmotes(): Map<string, TwitchEmote> | null {
  const [emotes, setEmotes] = useState<Map<string, TwitchEmote> | null>(
    memoryCache
  );

  useEffect(() => {
    if (emotes) return;
    let cancelled = false;
    getTwitchGlobalEmotes()
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
