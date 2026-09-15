import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type UpdateStatus } from "./api";

interface UpdateContextValue {
  status: UpdateStatus | null;
  checking: boolean;
  lastChecked: Date | null;
  /** Runs an update check immediately, regardless of the background poll timer. */
  checkNow: () => Promise<UpdateStatus | null>;
}

const UpdateContext = createContext<UpdateContextValue | null>(null);

const POLL_MS = 10 * 60 * 1000;

export function UpdateProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const checkingRef = useRef(false);

  const checkNow = useCallback(async () => {
    if (checkingRef.current) return status;
    checkingRef.current = true;
    setChecking(true);
    try {
      const res = await api.updateCheck();
      setStatus(res);
      setLastChecked(new Date());
      return res;
    } catch {
      // GitHub may be unreachable, or no releases exist yet — keep last known status
      return null;
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    checkNow();
    const id = setInterval(checkNow, POLL_MS);
    return () => clearInterval(id);
  }, [checkNow]);

  return (
    <UpdateContext.Provider value={{ status, checking, lastChecked, checkNow }}>
      {children}
    </UpdateContext.Provider>
  );
}

export function useUpdate() {
  const ctx = useContext(UpdateContext);
  if (!ctx) throw new Error("useUpdate must be used within an UpdateProvider");
  return ctx;
}
