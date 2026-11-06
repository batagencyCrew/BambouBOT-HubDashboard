import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError } from "./api";
import type { User } from "./types";

interface AuthState {
  user: User | null;
  checking: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
  /** Mirrors the backend Principal.can_site: permission plus optional site scope. */
  can: (permission: string, siteId?: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);

  const reload = useCallback(async () => {
    try {
      const data = await api.get<{ user: User }>("/auth/me");
      setUser(data.user);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setUser(null);
      else throw err;
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    reload().catch(() => setChecking(false));
    const onExpired = () => setUser(null);
    window.addEventListener("auth:expired", onExpired);
    return () => window.removeEventListener("auth:expired", onExpired);
  }, [reload]);

  const login = useCallback(async (username: string, password: string) => {
    const data = await api.post<{ user: User }>("/auth/login", { username, password });
    setUser(data.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } finally {
      setUser(null);
    }
  }, []);

  const can = useCallback(
    (permission: string, siteId?: string) => {
      if (!user || !user.permissions.includes(permission)) return false;
      if (siteId && user.site_scope && !user.site_scope.includes(siteId)) return false;
      return true;
    },
    [user],
  );

  const value = useMemo(() => ({ user, checking, login, logout, reload, can }), [user, checking, login, logout, reload, can]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
