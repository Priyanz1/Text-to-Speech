import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { api } from '../../lib/apiClient.js';
import { toFormMessage } from '../../lib/formError.js';
import { AuthLayout } from './AuthLayout.jsx';
import { useAuth } from './authContext.js';

/**
 * Lands the user here from the link in their email: /verify-email?token=...
 *
 * The token is read from the URL and sent in the request body, so it never ends
 * up in the API's own access logs.
 */
export function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const { status: authStatus, isAuthenticated, reloadUser } = useAuth();

  const [state, setState] = useState({ status: 'verifying', message: '' });

  // The token is single use, so this request must fire exactly once. StrictMode
  // runs effects twice in development, and without this guard the second call
  // would spend the token and then report the link as invalid.
  const requested = useRef(false);

  useEffect(() => {
    // No token means there is nothing to send; that case is handled during
    // render below. Waiting for the session check means isAuthenticated is the
    // real answer rather than "not yet known".
    if (!token || authStatus === 'loading' || requested.current) return;
    requested.current = true;

    async function verify() {
      try {
        const response = await api.post(
          '/api/auth/verify-email',
          { token },
          { skipAuthRefresh: true },
        );

        // If they were already signed in, re-read the user so the "confirm your
        // email" notice on the dashboard disappears without a reload.
        if (isAuthenticated) {
          await reloadUser().catch(() => {});
        }

        setState({ status: 'done', message: response.data.message });
      } catch (cause) {
        setState({ status: 'failed', message: toFormMessage(cause) });
      }
    }

    // eslint-disable-next-line react/set-state-in-effect
    verify();
  }, [authStatus, isAuthenticated, reloadUser, token]);

  if (!token) {
    return (
      <AuthLayout title="Link incomplete" subtitle="Email confirmation">
        <p className="form-error" role="alert">
          This confirmation link is missing its token. Open the most recent link from your
          email, or request a new one.
        </p>
        <Link className="form-aside" to="/resend-verification">
          Send a new link
        </Link>
      </AuthLayout>
    );
  }

  if (state.status === 'verifying') {
    return (
      <AuthLayout title="Confirming your email" subtitle="Email confirmation">
        <p className="status">
          <span className="dot" aria-hidden="true" />
          Checking your link…
        </p>
      </AuthLayout>
    );
  }

  if (state.status === 'failed') {
    return (
      <AuthLayout title="That link did not work" subtitle="Email confirmation">
        <p className="form-error" role="alert">
          {state.message}
        </p>
        {/* Expired and already-used links both land here, and both are fixed the
            same way: ask for a fresh one. */}
        <p className="form-note">
          Confirmation links expire, and each one can only be used once. Request a new
          link and open the most recent email.
        </p>
        <Link className="form-aside" to="/resend-verification">
          Send a new link
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Email confirmed" subtitle="Email confirmation">
      <p className="status status-good">
        <span className="dot" aria-hidden="true" />
        {state.message}
      </p>
      <Link className="form-aside" to={isAuthenticated ? '/dashboard' : '/login'}>
        {isAuthenticated ? 'Go to your dashboard' : 'Sign in'}
      </Link>
    </AuthLayout>
  );
}
