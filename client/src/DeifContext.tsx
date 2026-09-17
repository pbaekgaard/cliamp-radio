import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";

interface DeifState {
  name: string | null;
  loading: boolean;
  identify: (name: string) => Promise<void>;
  forget: () => Promise<void>;
}

const DeifContext = createContext<DeifState | null>(null);

export function DeifProvider({ children }: { children: ReactNode }) {
  const [name, setName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .deifMe()
      .then((res) => setName(res.name))
      .catch(() => setName(null))
      .finally(() => setLoading(false));
  }, []);

  async function identify(newName: string) {
    const res = await api.deifIdentify(newName);
    setName(res.name);
  }

  async function forget() {
    await api.deifLogout();
    setName(null);
  }

  return <DeifContext.Provider value={{ name, loading, identify, forget }}>{children}</DeifContext.Provider>;
}

export function useDeif() {
  const ctx = useContext(DeifContext);
  if (!ctx) throw new Error("useDeif must be used within DeifProvider");
  return ctx;
}
