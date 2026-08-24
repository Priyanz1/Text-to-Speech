import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  api,
  bootstrapSession,
  setAccessToken,
  setSessionExpiredHandler,
} from '../../lib/apiClient.js';
import { AuthContext } from './authContext.js';

/**
 * Owns "who is signed in".
 *
 * `status` starts at 'loading' and that distinction matters: on a reload there is
 * a moment where we hold no access token but the refresh cookie may still be
 * good. Treating that moment as signed-out would bounce the user to /login and
 * then back, so ProtectedRoute waits for 'ready' instead.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    let cancelled = false;

    // The access token lives in memory, so a reload starts without one. The
    // refresh cookie survives, so this asks the API who we are before rendering
    // anything that depends on the answer.
    async function restore() {
      const restored = await bootstrapSession();
      if (cancelled) return;

      setUser(restored);
      setStatus('ready');
    }

    // eslint-disable-next-line react/set-state-in-effect
    restore();

    // A refresh that fails later - the token was revoked, or 30 days passed -
    // reports back through here rather than leaving stale UI on screen.
    setSessionExpiredHandler(() => {
      if (!cancelled) setUser(null);
    });

    return () => {
      cancelled = true;
      setSessionExpiredHandler(() => {});
    };
  }, []);

  const login = useCallback(async (credentials) => {
    // skipAuthRefresh: a 401 here means the password was wrong. Trying to refresh
    // and retry would swallow that and report something confusing instead.
    const response = await api.post('/api/auth/login', credentials, { skipAuthRefresh: true });

    setAccessToken(response.data.accessToken);
    setUser(response.data.user);

    return response.data.user;
  }, []);

  const signup = useCallback(async (details) => {
    // Deliberately does not sign anyone in: the API returns a message, not a
    // session, so that its answer is identical for an address that already exists.
    const response = await api.post('/api/auth/signup', details, { skipAuthRefresh: true });
    return response.data.message;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout', undefined, { skipAuthRefresh: true });
    } finally {
      // Clear locally even if the request failed. The alternative is a UI that
      // claims you are still signed in after you asked not to be.
      setAccessToken(null);
      setUser(null);
    }
  }, []);

  /** Re-reads the user, for when something server-side changed - e.g. verification. */
  const reloadUser = useCallback(async () => {
    const response = await api.get('/api/auth/me');
    setUser(response.data.user);
    return response.data.user;
  }, []);

  const value = useMemo(
    () => ({
      user,
      status,
      isAuthenticated: user !== null,
      login,
      signup,
      logout,
      reloadUser,
      setUser,
    }),
    [user, status, login, signup, logout, reloadUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
