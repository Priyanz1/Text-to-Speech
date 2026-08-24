import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api } from '../../lib/apiClient.js';
import { toFormMessage } from '../../lib/formError.js';
import { useAuth } from '../auth/authContext.js';
import { HealthPanel } from '../health/HealthPanel.jsx';
import { StudioPanel } from '../studio/StudioPanel.jsx';

/** Shown once a session exists: the speech form, the account, and API health. */
export function DashboardPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const [isSigningOut, setIsSigningOut] = useState(false);
  const [resend, setResend] = useState({ status: 'idle', message: '' });

  // Defaulted, because a just-verified or just-loaded session may not carry the
  // buckets yet. The form and this card read the same object, so they never
  // disagree.
  const credits = {
    total: user.credits?.total ?? 0,
    subscription: user.credits?.subscription ?? 0,
    purchased: user.credits?.purchased ?? 0,
    planSlug: user.credits?.planSlug,
  };

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
    <main className="shell shell-wide">
      <header className="header header-row">
        <div>
          <h1>AI Text&#8209;to&#8209;Speech</h1>
          <p className="subtitle">Signed in as {user.email}</p>
        </div>
        <div className="header-actions">
          <Link className="download" to="/history">
            History
          </Link>
          <button type="button" onClick={handleLogout} disabled={isSigningOut}>
            {isSigningOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </header>

      {/* The balance gets its own line at the top of the page rather than only a
          number in the form's corner: it is what decides whether anything below is
          usable, and it is the first thing to check when a generate button is
          disabled. It re-renders from the same user state the form updates after a
          generation, so it cannot show a pre-generation figure. */}
      <section className="card balance-card">
        <div>
          <p className="balance-label">Credits available</p>
          <p className="balance-value">{credits.total.toLocaleString()}</p>
        </div>
        <dl className="balance-split">
          <div>
            <dt>Subscription</dt>
            <dd>{credits.subscription.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Purchased</dt>
            <dd>{credits.purchased.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Plan</dt>
            <dd>{credits.planSlug ?? user.planSlug}</dd>
          </div>
        </dl>
      </section>

      {/* An unverified account can still sign in - confirmation is what releases
          the free credits, not what grants access. So this is a nudge, not a wall,
          but until it is done the form below has nothing to spend. */}
      {user.emailVerified ? null : (
        <section className="card notice">
          <div className="card-head">
            <h2>Confirm your email</h2>
            <button type="button" onClick={handleResend} disabled={resend.status === 'sending'}>
              {resend.status === 'sending' ? 'Sending…' : 'Resend link'}
            </button>
          </div>
          <p className="form-note">
            {resend.message ||
              `We sent a confirmation link to ${user.email}. Your free credits arrive when you open it.`}
          </p>
        </section>
      )}

      <div className="stack">
        <StudioPanel />
      </div>

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
            <dt>Plan</dt>
            <dd>{user.planSlug}</dd>
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
        Credits are spent per character. Paid plans and checkout arrive in a later phase.
      </footer>
    </main>
  );
}
