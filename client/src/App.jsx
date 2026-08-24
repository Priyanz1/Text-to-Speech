import { useCallback, useEffect, useState } from 'react';

import { env } from './config/env.js';
import { api } from './lib/apiClient.js';

/**
 * Phase 1 status screen.
 *
 * Its job is to prove the deployed chain works end to end:
 * browser -> Vercel -> CORS -> Render -> MongoDB Atlas -> back again.
 *
 * It calls both probes because they answer different questions, and seeing them
 * separately is what makes a "the API is up but the database is not" situation
 * readable at a glance.
 *
 * Phase 4 replaces this with the router and real screens, and moves data
 * fetching to TanStack Query.
 */

// Wraps a probe call so one failing does not hide the other's result. A 503 from
// /api/ready is a useful answer, not an error - its body says why.
async function probe(path) {
  try {
    const response = await api.get(path);
    return { reachable: true, data: response.data, error: null };
  } catch (error) {
    return {
      reachable: false,
      data: error.payload?.data ?? null,
      error: error.message,
    };
  }
}

export default function App() {
  const [liveness, setLiveness] = useState(null);
  const [readiness, setReadiness] = useState(null);
  // Starts true because the effect below checks immediately on mount.
  const [isChecking, setIsChecking] = useState(true);

  // No setState before the first `await`: updating state synchronously inside
  // an effect starts a second render pass for no reason.
  const runChecks = useCallback(async () => {
    const [live, ready] = await Promise.all([probe('/api/health'), probe('/api/ready')]);
    setLiveness(live);
    setReadiness(ready);
    setIsChecking(false);
  }, []);

  useEffect(() => {
    // The lint rule cannot see that every setState in runChecks happens after
    // an await. Fetching on mount is the intended behaviour here, and Phase 4
    // hands this job to TanStack Query.
    // eslint-disable-next-line react/set-state-in-effect
    runChecks();
  }, [runChecks]);

  function handleRecheck() {
    setIsChecking(true);
    runChecks();
  }

  // The API being unreachable is the one failure worth showing prominently:
  // everything else is a detail in the table below.
  const connectionError = isChecking ? null : (liveness?.reachable ? null : liveness?.error);

  const overall = isChecking
    ? 'unknown'
    : connectionError
      ? 'bad'
      : readiness?.reachable
        ? 'good'
        : 'bad';

  const summary = isChecking
    ? 'Contacting the API…'
    : (connectionError ??
      (readiness?.reachable
        ? 'API reachable and ready to serve traffic'
        : 'API is alive but not ready — check the database row below'));

  return (
    <main className="shell">
      <header className="header">
        <h1>AI Text&#8209;to&#8209;Speech</h1>
        <p className="subtitle">Phase 1 &mdash; deployment</p>
      </header>

      <section className="card">
        <div className="card-head">
          <h2>API connection</h2>
          <button type="button" onClick={handleRecheck} disabled={isChecking}>
            {isChecking ? 'Checking…' : 'Re-check'}
          </button>
        </div>

        <p className={`status status-${overall}`}>
          <span className="dot" aria-hidden="true" />
          {summary}
        </p>

        <dl className="facts">
          <div>
            <dt>API base URL</dt>
            <dd>{env.apiBaseUrl}</dd>
          </div>
          <div>
            <dt>Liveness (/api/health)</dt>
            <dd>{liveness?.data?.status ?? (isChecking ? '…' : 'unreachable')}</dd>
          </div>
          <div>
            <dt>Readiness (/api/ready)</dt>
            <dd>{readiness?.data?.status ?? (isChecking ? '…' : 'unreachable')}</dd>
          </div>
          <div>
            <dt>Database</dt>
            <dd>{readiness?.data?.database ?? '—'}</dd>
          </div>
          <div>
            <dt>Server environment</dt>
            <dd>{liveness?.data?.environment ?? '—'}</dd>
          </div>
          <div>
            <dt>Server uptime</dt>
            <dd>{liveness?.data ? `${liveness.data.uptimeSeconds}s` : '—'}</dd>
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
