import { useEffect, useState } from "react";

/** A single 7TV emote, reduced down to what the chat needs to render it. */
export type SevenTvEmote = {
  id: string;
  name: string;
  animated: boolean;
  /** A ~64px-tall image URL (webp) — animated if the emote is. */
  url: string;
};

type SevenTvEmoteHost = { url: string; files: { name: string }[] };
type SevenTvApiEmote = {
  id: string;
  name: string;
  data?: { animated?: boolean; host?: SevenTvEmoteHost };
};

// 7TV's public v3 REST API is free, requires no API key/auth, and sets a
// permissive CORS policy (it's designed for exactly this — third-party
// sites embedding chat pull emote sets directly from the browser). The
// "global" set is a small, curated, mostly-animated collection maintained
// by 7TV itself, so it works without picking a specific channel/user.
const GLOBAL_EMOTE_SET_URL = "https://7tv.io/v3/emote-sets/global";

// 7tv.app's actual site — the "Top"/"Trending" tabs on 7tv.app/emotes —
// runs on a newer v4 GraphQL API instead of the v3 REST one above. It's
// still free/no-auth/CORS-open (it's the public frontend API), and is the
// only way to get the *actually* famous, no-channel-required emotes people
// mean by "7TV emotes" (GIGACHAD, KEKW, OMEGALUL, PogU, ...) rather than
// the tiny curated "global" set, which most people never see on 7tv.app.
const V4_GQL_URL = "https://api.7tv.app/v4/gql";
const EMOTE_SEARCH_QUERY = `
  query EmoteSearch($sortBy: SortBy!, $perPage: Int!) {
    emotes {
      search(
        query: null
        tags: { tags: [], match: ANY }
        sort: { sortBy: $sortBy, order: DESCENDING }
        filters: {}
        page: 1
        perPage: $perPage
      ) {
        items {
          id
          defaultName
          images { url mime scale frameCount }
        }
      }
    }
  }
`;
type V4Image = { url: string; mime: string; scale: number; frameCount: number };
type V4Emote = { id: string; defaultName: string; images: V4Image[] };

const EXACT_SEARCH_QUERY = `
  query EmoteExactSearch($query: String!, $perPage: Int!) {
    emotes {
      search(
        query: $query
        tags: { tags: [], match: ANY }
        sort: { sortBy: TOP_ALL_TIME, order: DESCENDING }
        filters: {}
        page: 1
        perPage: $perPage
      ) {
        items {
          id
          defaultName
          images { url mime scale frameCount }
        }
      }
    }
  }
`;

const CACHE_KEY = "sevenTvEmotesV2";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — emote sets rarely change

let memoryCache: Map<string, SevenTvEmote> | null = null;
let inflight: Promise<Map<string, SevenTvEmote>> | null = null;

function bestFile(host: SevenTvEmoteHost): string | null {
  const preferred = ["2x.webp", "1x.webp", "3x.webp", "4x.webp"];
  for (const name of preferred) {
    if (host.files.some((f) => f.name === name)) return name;
  }
  return host.files[0]?.name ?? null;
}

function toEmote(raw: SevenTvApiEmote): SevenTvEmote | null {
  const host = raw.data?.host;
  if (!host) return null;
  const file = bestFile(host);
  if (!file) return null;
  return {
    id: raw.id,
    name: raw.name,
    animated: !!raw.data?.animated,
    // host.url is protocol-relative ("//cdn.7tv.app/emote/...").
    url: `https:${host.url}/${file}`,
  };
}

async function fetchGlobalEmotes(): Promise<SevenTvEmote[]> {
  const res = await fetch(GLOBAL_EMOTE_SET_URL);
  if (!res.ok) throw new Error(`7tv fetch failed: ${res.status}`);
  const body = (await res.json()) as { emotes?: SevenTvApiEmote[] };
  const out: SevenTvEmote[] = [];
  for (const raw of body.emotes ?? []) {
    const emote = toEmote(raw);
    if (emote) out.push(emote);
  }
  return out;
}

function v4BestImage(images: V4Image[]): V4Image | null {
  // Prefer an animated (frameCount > 1) 2x webp when available, matching
  // what 7tv.app itself renders in its emote grid; fall back to whatever's
  // there otherwise.
  return (
    images.find((i) => i.mime === "image/webp" && i.scale === 2 && i.frameCount > 1) ??
    images.find((i) => i.mime === "image/webp" && i.scale === 2) ??
    images[0] ??
    null
  );
}

async function fetchV4Chart(sortBy: string, perPage: number): Promise<SevenTvEmote[]> {
  const res = await fetch(V4_GQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operationName: "EmoteSearch",
      query: EMOTE_SEARCH_QUERY,
      variables: { sortBy, perPage },
    }),
  });
  if (!res.ok) throw new Error(`7tv v4 fetch failed: ${res.status}`);
  const body = (await res.json()) as {
    data?: { emotes?: { search?: { items?: V4Emote[] } } };
  };
  const items = body.data?.emotes?.search?.items ?? [];
  const out: SevenTvEmote[] = [];
  for (const raw of items) {
    const image = v4BestImage(raw.images);
    if (!image) continue;
    out.push({
      id: raw.id,
      name: raw.defaultName,
      animated: image.frameCount > 1,
      url: image.url,
    });
  }
  return out;
}

async function fetchAllSevenTvEmotes(): Promise<Map<string, SevenTvEmote>> {
  // All-time favorites plus what's hot right now, same two charts as the
  // "Top"/"Trending" tabs on 7tv.app/emotes — between them this covers
  // essentially every emote someone would recognize by name. Any of these
  // three sources failing shouldn't sink the other two, so they're settled
  // independently.
  const [globalRes, topRes, trendingRes] = await Promise.allSettled([
    fetchGlobalEmotes(),
    fetchV4Chart("TOP_ALL_TIME", 150),
    fetchV4Chart("TRENDING_DAILY", 100),
  ]);
  const map = new Map<string, SevenTvEmote>();
  for (const result of [topRes, trendingRes, globalRes]) {
    if (result.status !== "fulfilled") continue;
    for (const emote of result.value) map.set(emote.name, emote);
  }
  if (map.size === 0) throw new Error("7tv: all emote sources failed");
  return map;
}

function readCache(): Map<string, SevenTvEmote> | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      ts: number;
      entries: [string, SevenTvEmote][];
    };
    if (Date.now() - parsed.ts > CACHE_TTL_MS) return null;
    return new Map(parsed.entries);
  } catch {
    return null;
  }
}

function writeCache(map: Map<string, SevenTvEmote>) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ ts: Date.now(), entries: [...map.entries()] })
    );
  } catch {
    // best-effort — a full/disabled localStorage just means re-fetching
  }
}

/** Fetches (and caches, in-memory + localStorage) 7TV's global, top, and
 * trending emote charts. Safe to call repeatedly — concurrent calls share
 * one in-flight request. */
export async function getSevenTvEmotes(): Promise<Map<string, SevenTvEmote>> {
  if (memoryCache) return memoryCache;
  if (!inflight) {
    inflight = (async () => {
      const cached = readCache();
      if (cached) {
        memoryCache = cached;
        return cached;
      }
      const map = await fetchAllSevenTvEmotes();
      memoryCache = map;
      writeCache(map);
      return map;
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** Loads 7TV's emote charts on mount; returns null until they're ready (or
 * if the fetch fails, in which case chat just renders plain text). */
export function useSevenTvEmotes(): Map<string, SevenTvEmote> | null {
  const [emotes, setEmotes] = useState<Map<string, SevenTvEmote> | null>(
    memoryCache
  );

  useEffect(() => {
    if (emotes) return;
    let cancelled = false;
    getSevenTvEmotes()
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

// ---------------------------------------------------------------------
// On-demand resolution — preloading covers the ~300 most-used emotes,
// but 7TV actually hosts hundreds of thousands (any channel/user can
// upload their own). Rather than trying to preload "all of them" (not
// realistic — that's the whole "requires the browser extension" problem
// this was meant to avoid), any exact emote name typed in chat that isn't
// already known gets looked up live by name and cached forever afterwards,
// so in practice *any* real 7TV emote works, the first time anyone uses it.
// ---------------------------------------------------------------------

const resolvedCache = new Map<string, SevenTvEmote | null>();
const resolveInflight = new Map<string, Promise<SevenTvEmote | null>>();

/** True for tokens worth spending a network request checking against 7TV
 * by exact name — emote names on 7TV/BTTV/Twitch are, by strong
 * convention, never plain all-lowercase words (they're PascalCase,
 * camelCase, or ALL CAPS), so this filters out ordinary chat words like
 * "hello" without ever needing to know what "hello" means. */
export function looksLikeEmoteToken(token: string): boolean {
  if (token.length < 3 || token.length > 100) return false;
  if (!/^[A-Za-z0-9_]+$/.test(token)) return false;
  if (!/[A-Z]/.test(token)) return false; // must contain at least one uppercase letter
  return token !== token.toLowerCase();
}

/** Looks up a single emote by its exact (case-sensitive) name against
 * 7TV's live search, picking the most-favorited upload of that name if
 * several channels have one — same tie-break the preloaded charts use.
 * Both hits and misses are cached forever (per page load) so repeats of
 * the same name, hit or miss, never re-hit the network. */
export async function resolveSevenTvEmoteByName(
  name: string
): Promise<SevenTvEmote | null> {
  if (resolvedCache.has(name)) return resolvedCache.get(name) ?? null;
  let promise = resolveInflight.get(name);
  if (!promise) {
    promise = (async () => {
      try {
        const res = await fetch(V4_GQL_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operationName: "EmoteExactSearch",
            query: EXACT_SEARCH_QUERY,
            variables: { query: name, perPage: 8 },
          }),
        });
        if (!res.ok) throw new Error(`7tv search failed: ${res.status}`);
        const body = (await res.json()) as {
          data?: { emotes?: { search?: { items?: V4Emote[] } } };
        };
        const items = body.data?.emotes?.search?.items ?? [];
        const exact = items.find((i) => i.defaultName === name) ?? null;
        const image = exact ? v4BestImage(exact.images) : null;
        const emote: SevenTvEmote | null =
          exact && image
            ? { id: exact.id, name: exact.defaultName, animated: image.frameCount > 1, url: image.url }
            : null;
        resolvedCache.set(name, emote);
        return emote;
      } catch {
        // Don't cache network failures — worth retrying next time it's seen.
        return null;
      } finally {
        resolveInflight.delete(name);
      }
    })();
    resolveInflight.set(name, promise);
  }
  return promise;
}

