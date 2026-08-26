import { createContext, use, useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  sessionResponseSchema,
  type LoginInput,
  type PublicUser,
  type RegisterInput,
} from '@invintelx/shared';
import { ApiError, apiRequest, apiVoid, setUnauthorizedHandler } from '@/lib/api';

interface AuthContextValue {
  user: PublicUser | null;
  /** True only during the initial session probe, so guards can wait it out. */
  isLoading: boolean;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const queryClient = useQueryClient();

  // Cookie is httpOnly, so the only way to know whether a session exists is to
  // ask the server once on boot.
  useEffect(() => {
    let cancelled = false;
    apiRequest(sessionResponseSchema, '/auth/me')
      .then((data) => {
        if (!cancelled) setUser(data.user);
      })
      .catch((error: unknown) => {
        // A 401 here just means "not signed in" - that is not an error state.
        if (!(error instanceof ApiError) || !error.isUnauthorized) {
          console.error('Session probe failed', error);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A 401 from any request means the session died mid-use. Drop the user and
  // clear cached data so the next screen cannot render stale rows.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      queryClient.clear();
    });
    return () => setUnauthorizedHandler(undefined);
  }, [queryClient]);

  const login = useCallback(async (input: LoginInput) => {
    const data = await apiRequest(sessionResponseSchema, '/auth/login', {
      method: 'POST',
      body: input,
    });
    setUser(data.user);
  }, []);

  const register = useCallback(async (input: RegisterInput) => {
    const data = await apiRequest(sessionResponseSchema, '/auth/register', {
      method: 'POST',
      body: input,
    });
    setUser(data.user);
  }, []);

  const logout = useCallback(async () => {
    await apiVoid('/auth/logout', { method: 'POST' });
    setUser(null);
    queryClient.clear();
  }, [queryClient]);

  const value = useMemo(
    () => ({ user, isLoading, login, register, logout }),
    [user, isLoading, login, register, logout],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const context = use(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
