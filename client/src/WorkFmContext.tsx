import { createContext, useContext, useState, type ReactNode } from "react";
import { api } from "./api";

interface WorkFmState {
  name: string | null;
  /** Which room `name` was picked for. WorkFM deliberately doesn't remember
   * names across rooms (or across reloads) — entering a different room
   * always re-prompts, even if you already picked a name elsewhere. */
  roomSlug: string | null;
  loading: boolean;
  /** Picks a name and binds it to `slug` (a real room slug, or "" if the
   * room doesn't exist yet — see `bindRoom`). */
  identify: (name: string, slug: string) => Promise<void>;
  /** Rebinds the current identity to `slug` without a network round-trip —
   * used right after creating a room, once its slug is known. */
  bindRoom: (slug: string) => void;
  forget: () => Promise<void>;
}

const WorkFmContext = createContext<WorkFmState | null>(null);

export function WorkFmProvider({ children }: { children: ReactNode }) {
  // No restore-from-cookie on mount: names are intentionally forgotten
  // between visits and between rooms, so everyone always starts fresh.
  const [name, setName] = useState<string | null>(null);
  const [roomSlug, setRoomSlug] = useState<string | null>(null);
  const [loading] = useState(false);

  async function identify(newName: string, slug: string) {
    const res = await api.workfmIdentify(newName);
    setName(res.name);
    setRoomSlug(slug);
  }

  function bindRoom(slug: string) {
    setRoomSlug(slug);
  }

  async function forget() {
    await api.workfmLogout();
    setName(null);
    setRoomSlug(null);
  }

  return (
    <WorkFmContext.Provider value={{ name, roomSlug, loading, identify, bindRoom, forget }}>
      {children}
    </WorkFmContext.Provider>
  );
}

export function useWorkFm() {
  const ctx = useContext(WorkFmContext);
  if (!ctx) throw new Error("useWorkFm must be used within WorkFmProvider");
  return ctx;
}
