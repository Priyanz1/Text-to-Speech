import { useCallback, useEffect, useState } from 'react';

import { env } from './config/env.js';
import { api } from './lib/apiClient.js';

/**
 * Phase 0 placeholder screen.
 *
 * Its only job is to prove the full chain is wired up:
 * browser -> Vite dev server -> CORS -> Express -> MongoDB -> back again.
 *
 * Phase 4 replaces this with the router and real screens, and moves data
 * fetching to TanStack Query (which handles caching, retries and cancellation
 * properly - deliberately not reinvented here).
 */
export default function App() {
  const [health, setHealth] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  // Starts true because the effect below checks immediately on mount.
  const [isChecking, setIsChecking] = useState(true);

  // No setState before the first `await`: updating state synchronously inside
  // an effect starts a second render pass for no reason.
  const runHealthCheck = useCallback(async () => {
    try {
      const response = await api.get('/api/health');
      setHealth(response.data);
      setErrorMessage(null);
    } catch (error) {
      // A 503 from /api/health is still useful: the body tells us the server
      // is up but the database is not connected.
      setHealth(error.payload?.data ?? null);
      setErrorMessage(error.message);
    } finally {
      setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    // The lint rule cannot see that every setState in runHealthCheck happens
    // after an await. Fetching on mount is the intended behaviour here, and
    // Phase 4 hands this job to TanStack Query.
    // eslint-disable-next-line react/set-state-in-effect
    runHealthCheck();
  }, [runHealthCheck]);

  function handleRecheck() {
    setIsChecking(true);
    runHealthCheck();
  }

  const state = isChecking ? 'unknown' : errorMessage ? 'bad' : 'good';

  return (
    <main className="shell">
      <header className="header">
        <h1>AI Text&#8209;to&#8209;Speech</h1>
        <p className="subtitle">Phase 0 &mdash; project foundation</p>
      </header>

      <section className="card">
        <div className="card-head">
          <h2>API connection</h2>
          <button type="button" onClick={handleRecheck} disabled={isChecking}>
            {isChecking ? 'Checking…' : 'Re-check'}
          </button>
        </div>

        <p className={`status status-${state}`}>
          <span className="dot" aria-hidden="true" />
          {isChecking ? 'Contacting the API…' : (errorMessage ?? 'API reachable')}
        </p>

        <dl className="facts">
          <div>
            <dt>API base URL</dt>
            <dd>{env.apiBaseUrl}</dd>
          </div>
          <div>
            <dt>Server status</dt>
            <dd>{health?.status ?? '—'}</dd>
          </div>
          <div>
            <dt>Database</dt>
            <dd>{health?.database ?? '—'}</dd>
          </div>
          <div>
            <dt>Server environment</dt>
            <dd>{health?.environment ?? '—'}</dd>
          </div>
          <div>
            <dt>Server uptime</dt>
            <dd>{health ? `${health.uptimeSeconds}s` : '—'}</dd>
          </div>
          <div>
            <dt>Client mode</dt>
            <dd>{env.mode}</dd>
          </div>
        </dl>
      </section>

      <footer className="footer">
        No authentication, credits or speech generation yet &mdash; those arrive in later phases.
      </footer>
    </main>
  );
}
