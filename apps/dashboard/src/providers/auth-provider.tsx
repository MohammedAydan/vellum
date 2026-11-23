import * as React from "react";
import { getStoredSession, setStoredSession, clearStoredSession, type UserSession } from "../lib/auth.js";
import { resetApiClientState } from "../lib/api.js";
import { queryClient } from "../lib/query-client.js";

interface AuthContextValue {
  session: UserSession | null;
  isAuthenticated: boolean;
  login: (session: UserSession) => void;
  logout: () => void;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<UserSession | null>(() => getStoredSession());

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith("vellum_console_")) {
        const next = getStoredSession();
        if (!next) {
          resetApiClientState();
          queryClient.clear();
        }
        setSession(next);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const login = React.useCallback((newSession: UserSession) => {
    resetApiClientState();
    queryClient.clear();
    setStoredSession(newSession);
    setSession(newSession);
  }, []);

  const logout = React.useCallback(() => {
    resetApiClientState();
    clearStoredSession();
    queryClient.clear();
    setSession(null);
  }, []);

  const value = React.useMemo(
    () => ({
      session,
      isAuthenticated: session !== null,
      login,
      logout,
    }),
    [session, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = React.useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
