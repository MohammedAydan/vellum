import * as React from "react";
import {
  type AdminSession,
  getStoredAdminSession,
  setStoredAdminSession,
  clearStoredAdminSession,
} from "../lib/auth.js";
import { resetAdminApiClientState } from "../lib/api.js";
import { queryClient } from "../lib/query-client.js";

interface AuthContextType {
  session: AdminSession | null;
  login: (session: AdminSession) => void;
  logout: () => void;
  isLoading: boolean;
}

const AuthContext = React.createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<AdminSession | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    const stored = getStoredAdminSession();
    if (stored) {
      setSession(stored);
    }
    setIsLoading(false);

    if (typeof window === "undefined") return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith("vellum_super_admin_")) {
        const next = getStoredAdminSession();
        if (!next) {
          resetAdminApiClientState();
          queryClient.clear();
        }
        setSession(next);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const login = React.useCallback((newSession: AdminSession) => {
    setStoredAdminSession(newSession);
    setSession(newSession);
  }, []);

  const logout = React.useCallback(() => {
    resetAdminApiClientState();
    clearStoredAdminSession();
    queryClient.clear();
    setSession(null);
  }, []);

  const value = React.useMemo(
    () => ({ session, login, logout, isLoading }),
    [session, login, logout, isLoading]
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAdminAuth() {
  const context = React.useContext(AuthContext);
  if (!context) {
    throw new Error("useAdminAuth must be used within an AuthProvider");
  }
  return context;
}
