import { Navigate, useLocation } from 'react-router-dom';

import { useAuth } from '../features/auth/authContext.js';

/**
 * Gates a route on being signed in.
 *
 * The 'loading' case has to be handled separately from the signed-out case. On a
 * reload the access token is gone but the refresh cookie may still be valid, and
 * treating that in-between moment as signed-out would redirect the user to
 * /login and then straight back - a visible flicker on every refresh.
 *
 * This is convenience, not security: the real check is server-side on every
 * request. Someone can always route themselves here, and the API will still say no.
 */
export function ProtectedRoute({ children }) {
  const { status, isAuthenticated } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <main className="shell">
        <p className="status">
          <span className="dot" aria-hidden="true" />
          Checking your session…
        </p>
      </main>
    );
  }

  if (!isAuthenticated) {
    // `state.from` is how the login page sends the user back where they were
    // heading, instead of dumping everyone on the dashboard. `replace` keeps the
    // gated URL out of history, so Back does not bounce off this redirect.
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return children;
}
