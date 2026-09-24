import { useMemo } from "react";
import { useBttvGlobalEmotes } from "./bttvEmotes";
import { useSevenTvEmotes } from "./sevenTv";
import { useTwitchGlobalEmotes } from "./twitchEmotes";

export type ChatEmote = {
  id: string;
  name: string;
  animated: boolean;
  url: string;
  source: "7tv" | "twitch" | "bttv";
};

/** Merges 7TV's, Twitch's, and BTTV's global emote sets into one lookup,
 * keyed by the exact (case-sensitive) name chatters type — e.g. "PogChamp"
 * or "monkaS". If a name exists in more than one, later sources below win
 * (arbitrary but consistent). A partial map is returned as soon as any one
 * source is ready rather than waiting on all three; null only before all
 * of them have loaded. */
export function useChatEmotes(): Map<string, ChatEmote> | null {
  const sevenTv = useSevenTvEmotes();
  const twitch = useTwitchGlobalEmotes();
  const bttv = useBttvGlobalEmotes();

  return useMemo(() => {
    if (!sevenTv && !twitch && !bttv) return null;
    const map = new Map<string, ChatEmote>();
    for (const e of twitch?.values() ?? []) {
      map.set(e.name, { ...e, source: "twitch" });
    }
    for (const e of bttv?.values() ?? []) {
      map.set(e.name, { ...e, source: "bttv" });
    }
    for (const e of sevenTv?.values() ?? []) {
      map.set(e.name, { ...e, source: "7tv" });
    }
    return map;
  }, [sevenTv, twitch, bttv]);
}
