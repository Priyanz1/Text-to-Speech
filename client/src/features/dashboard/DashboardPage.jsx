import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '../../lib/apiClient.js';
import { toFormMessage } from '../../lib/formError.js';
import { useAuth } from '../auth/authContext.js';
import { HealthPanel } from '../health/HealthPanel.jsx';

/** Shown once a confirmed session exists. Speech generation arrives in a later phase. */
export function DashboardPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const [isSigningOut, setIsSigningOut] = useState(false);
  const [resend, setResend] = useState({ status: 'idle', message: '' });

  async function handleLogout() {
    setIsSigningOut(true);
    await logout();
    navigate('/login', { replace: true });
  }

  async function handleResend() {
    setResend({ status: 'sending', message: '' });

    try {
      const response = await api.post('/api/auth/resend-verification', { email: user.email });
      setResend({ status: 'sent', message: response.data.message });
    } catch (error) {
      setResend({ status: 'failed', message: toFormMessage(error) });
    }
  }

  return (
    <main className="shell">
      <header className="header header-row">
        <div>
          <h1>AI Text&#8209;to&#8209;Speech</h1>
          <p className="subtitle">Signed in as {user.email}</p>
        </div>
        <button type="button" onClick={handleLogout} disabled={isSigningOut}>
          {isSigningOut ? 'Signing out…' : 'Sign out'}
        </button>
      </header>

      {/* An unverified account can still sign in - confirmation gates the free
          credit grant in a later phase, not access. So this is a nudge, not a wall. */}
      {user.emailVerified ? null : (
        <section className="card notice">
          <div className="card-head">
            <h2>Confirm your email</h2>
            <button type="button" onClick={handleResend} disabled={resend.status === 'sending'}>
              {resend.status === 'sending' ? 'Sending…' : 'Resend link'}
            </button>
          </div>
          <p className="form-note">
            {resend.message || `We sent a confirmation link to ${user.email}.`}
          </p>
        </section>
      )}

      <section className="card stack">
        <div className="card-head">
          <h2>Your account</h2>
        </div>

        <dl className="facts">
          <div>
            <dt>Name</dt>
            <dd>{user.name}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{user.email}</dd>
          </div>
          <div>
            <dt>Email confirmed</dt>
            <dd>{user.emailVerified ? 'yes' : 'no'}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>{user.role}</dd>
          </div>
          <div>
            <dt>Member since</dt>
            <dd>{new Date(user.createdAt).toLocaleDateString()}</dd>
          </div>
        </dl>
      </section>

      <div className="stack">
        <HealthPanel />
      </div>

      <footer className="footer">
        Credits, voices and speech generation arrive in later phases.
      </footer>
    </main>
  );
}
