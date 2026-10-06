import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { ExpertProfile } from './api';

export type SessionStatus =
  { kind: 'unknown' } | { kind: 'anonymous' } | { kind: 'authenticated'; profile: ExpertProfile };

export type AuthContextValue = {
  status: SessionStatus;
  setProfile: (profile: ExpertProfile) => void;
  clear: () => void;
  refresh: () => Promise<void>;
  lastError: string | null;
  setError: (message: string | null) => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  fetcher,
  children,
}: {
  fetcher: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
  children: ReactNode;
}): ReactNode {
  const [status, setStatus] = useState<SessionStatus>({ kind: 'unknown' });
  const [lastError, setLastError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setStatus({ kind: 'unknown' });
    try {
      const response = await fetcher('/api/v1/me', {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (response.status === 200) {
        const data = (await response.json()) as ExpertProfile;
        setStatus({ kind: 'authenticated', profile: data });
        setLastError(null);
        return;
      }
      if (response.status === 401) {
        setStatus({ kind: 'anonymous' });
        return;
      }
      setStatus({ kind: 'anonymous' });
      setLastError('Не удалось получить профиль.');
    } catch {
      setStatus({ kind: 'anonymous' });
      setLastError('Не удалось получить профиль.');
    }
  }, [fetcher]);

  const setProfile = useCallback((profile: ExpertProfile) => {
    setStatus({ kind: 'authenticated', profile });
  }, []);

  const clear = useCallback(() => {
    setStatus({ kind: 'anonymous' });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      setProfile,
      clear,
      refresh,
      lastError,
      setError: setLastError,
    }),
    [status, setProfile, clear, refresh, lastError],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth должен вызываться внутри AuthProvider.');
  }
  return value;
}
