import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// WorkFM chat name colors — Twitch-style: every display name gets a color
// (deterministically picked from a fixed palette, so it's stable across
// restarts without needing storage), and anyone can override theirs with
// one of the same palette entries (see setColorForName / the
// POST /api/workfm/color route in index.ts). Overrides persist keyed by
// lowercased name, same durability model as chat history
// (workfm-chat-state.json) — plain JSON, rewritten on change.

/** Same palette Twitch hands out by default, restricted to colors that
 * stay readable on our dark chat background. Exported so the client's
 * color picker can offer exactly these (and nothing else) — keeping
 * validation trivial (`PRESET_COLORS.includes(color)`) and guaranteeing
 * every color anyone can end up with reads fine on a dark UI. */
export const PRESET_COLORS = [
  "#FF0000",
  "#0000FF",
  "#00FF00",
  "#B22222",
  "#FF7F50",
  "#9ACD32",
  "#FF4500",
  "#2E8B57",
  "#DAA520",
  "#D2691E",
  "#5F9EA0",
  "#1E90FF",
  "#FF69B4",
  "#8A2BE2",
  "#00FF7F",
  "#FF1493",
  "#00BFFF",
  "#F08080",
  "#ADFF2F",
  "#20B2AA",
] as const;

const COLORS_STATE_PATH = path.join(import.meta.dir, "..", "data", "workfm-colors.json");

// name (lowercased) -> chosen preset color. Only holds explicit overrides —
// anyone who hasn't picked a color yet just gets their deterministic
// default computed on the fly (see colorForName), so this stays small
// regardless of how many names have ever passed through.
const overrides = new Map<string, string>();
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(COLORS_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    for (const [name, color] of Object.entries(parsed)) {
      if (PRESET_COLORS.includes(color as (typeof PRESET_COLORS)[number])) overrides.set(name, color);
    }
  } catch {
    // No saved state yet, or it's unreadable — start with no overrides.
  }
}

/** Debounced write-through, same pattern as workfmQueue.ts's
 * saveChatState(): batches rapid-fire color changes into one write rather
 * than hitting disk on every request. */
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await mkdir(path.dirname(COLORS_STATE_PATH), { recursive: true });
      const tmp = `${COLORS_STATE_PATH}.tmp`;
      await writeFile(tmp, JSON.stringify(Object.fromEntries(overrides)));
      await rename(tmp, COLORS_STATE_PATH);
    } catch (err) {
      console.error("[workfm-colors] failed to persist:", err);
    }
  }, 500);
}

/** Cheap, stable string hash (djb2) — used only to deterministically pick
 * a palette index for names nobody has customized, so the same name
 * always lands on the same default color across restarts/servers without
 * needing to store anything for the common case. */
function hashName(name: string): number {
  let hash = 5381;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 33) ^ name.charCodeAt(i);
  }
  return hash >>> 0;
}

/** The color to render `name` in — their own pick if they've made one,
 * otherwise a deterministic default from PRESET_COLORS. */
export function getColorForName(name: string): string {
  ensureLoaded();
  const key = name.toLowerCase();
  const chosen = overrides.get(key);
  if (chosen) return chosen;
  return PRESET_COLORS[hashName(key) % PRESET_COLORS.length]!;
}

/** Records `name`'s chosen color (must be one of PRESET_COLORS — validated
 * by the caller in index.ts). */
export function setColorForName(name: string, color: string): void {
  ensureLoaded();
  overrides.set(name.toLowerCase(), color);
  saveState();
}

/** Carries an explicit color override over to a new name on rename, so
 * picking a custom color doesn't get silently forgotten (falling back to
 * the new name's deterministic default) just because the display name
 * changed. No-op if the old name never had an override. Doesn't delete
 * the old name's override — it's harmless to leave around, and someone
 * else could coincidentally share the old name later. */
export function renameColorOverride(oldName: string, newName: string): void {
  ensureLoaded();
  const chosen = overrides.get(oldName.toLowerCase());
  if (!chosen) return;
  overrides.set(newName.toLowerCase(), chosen);
  saveState();
}
