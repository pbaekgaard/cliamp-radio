import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";

interface AuthState {
  username: string | null;
  mustChangePassword: boolean;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  markPasswordChanged: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [username, setUsername] = useState<string | null>(null);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .me()
      .then((res) => {
        setUsername(res.username);
        setMustChangePassword(res.mustChangePassword);
      })
      .catch(() => setUsername(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(user: string, password: string) {
    const res = await api.login(user, password);
    setUsername(res.username);
    setMustChangePassword(res.mustChangePassword);
  }

  async function logout() {
    await api.logout();
    setUsername(null);
    setMustChangePassword(false);
  }

  function markPasswordChanged() {
    setMustChangePassword(false);
  }

  return (
    <AuthContext.Provider
      value={{ username, mustChangePassword, loading, login, logout, markPasswordChanged }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
