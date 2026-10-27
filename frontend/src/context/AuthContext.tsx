import * as React from "react";
import { api, authEvents, clearSession, getStoredUser, getToken, setSession } from "@/lib/api";
import type { User } from "@/lib/types";

// Single-account deployment: the app signs itself in as Ramnath, so no
// sign-in screen is ever shown.
const AUTO_USERNAME = "Ramnath";
const AUTO_PASSWORD = "Ramnath";

interface AuthContextValue {
  user: User | null;
  token: string | null;
  initializing: boolean;
  authError: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  retry: () => void;
  hasRole: (...roles: User["role"][]) => boolean;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<User | null>(() => getStoredUser());
  const [token, setToken] = React.useState<string | null>(() => getToken());
  const [initializing, setInitializing] = React.useState<boolean>(true);
  const [authError, setAuthError] = React.useState<string | null>(null);
  const [retryTick, setRetryTick] = React.useState(0);
  const blockedRef = React.useRef(false);

  React.useEffect(() => {
    const onLogout = () => {
      setUser(null);
      setToken(null);
    };
    authEvents.addEventListener("logout", onLogout);
    return () => authEvents.removeEventListener("logout", onLogout);
  }, []);

  React.useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setInitializing(true);
    api
      .me()
      .then((u) => {
        if (!cancelled) {
          setUser(u);
          setAuthError(null);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        clearSession();
        blockedRef.current = true;
        setAuthError(err instanceof Error ? err.message : "Session expired.");
      })
      .finally(() => {
        if (!cancelled) setInitializing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  React.useEffect(() => {
    if (token || blockedRef.current) return;
    let cancelled = false;
    setInitializing(true);
    api
      .login(AUTO_USERNAME, AUTO_PASSWORD)
      .then((res) => {
        if (cancelled) return;
        setSession(res.access_token, res.user);
        setToken(res.access_token);
        setUser(res.user);
        setAuthError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setAuthError(err instanceof Error ? err.message : "Automatic sign-in failed.");
      })
      .finally(() => {
        if (!cancelled) setInitializing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, retryTick]);

  const login = React.useCallback(async (username: string, password: string) => {
    const res = await api.login(username, password);
    setSession(res.access_token, res.user);
    setToken(res.access_token);
    setUser(res.user);
  }, []);

  const logout = React.useCallback(() => {
    clearSession();
    setUser(null);
    setToken(null);
  }, []);

  const retry = React.useCallback(() => {
    blockedRef.current = false;
    setAuthError(null);
    setRetryTick((t) => t + 1);
  }, []);

  const hasRole = React.useCallback(
    (...roles: User["role"][]) => {
      if (!user) return false;
      return roles.includes(user.role);
    },
    [user],
  );

  const value = React.useMemo(
    () => ({ user, token, initializing, authError, login, logout, retry, hasRole }),
    [user, token, initializing, authError, login, logout, retry, hasRole],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
