import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";

interface WorkFmState {
  name: string | null;
  /** Which room `name` was picked for. Restoring a session (see
   * WorkFmProvider) doesn't know this on its own — RoomPage binds it via
   * `bindRoom` once it mounts with a known slug, since WorkFM only ever has
   * the one persistent room in practice. */
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
  // Names *within* a room are still forgotten on a hard navigation between
  // rooms (see bindRoom), but a same-room page refresh shouldn't force
  // rejoining — the server already remembers who you are for 30 days via
  // the workfm_identity cookie (see workfmIdentity.ts), so restore it here
  // on mount rather than starting every reload from scratch. `loading`
  // gates WorkFm's initial render (see WorkFm() below) so the join modal
  // doesn't flash before this resolves.
  const [name, setName] = useState<string | null>(null);
  const [roomSlug, setRoomSlug] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.workfmMe();
        setName(res.name);
      } catch {
        // No valid session cookie — stays anonymous until they join.
      } finally {
        setLoading(false);
      }
    })();
  }, []);

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
