import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../../lib/apiClient.js';
import { toFormMessage } from '../../lib/formError.js';
import { useAuth } from '../auth/authContext.js';

/**
 * A read-only window onto the data, for an operator.
 *
 * Deliberately small, and deliberately without a single control that writes
 * anything. Prices, cost multipliers and who is an admin are all changed in the
 * database or by re-seeding - which is auditable, and cannot be reached by a
 * stolen session. An admin console that can grant credits is a much bigger hole
 * than an admin console that shows a stale number.
 *
 * The gate is server-side on every route (requireAuth + requireAdmin, reading the
 * role from the database rather than the token). This page's only job on a refusal
 * is to say so in a way that explains what to do about it, because a 403 here
 * almost always means "this account was never promoted".
 */
const PAGE_SIZE = 25;

const VIEWS = [
  { key: 'overview', label: 'Overview' },
  { key: 'users', label: 'Users' },
  { key: 'plans', label: 'Plans' },
  { key: 'voices', label: 'Voices' },
];

function pathFor(view, { page, search }) {
  switch (view) {
    case 'users':
      return `/api/admin/users?page=${page}&limit=${PAGE_SIZE}&search=${encodeURIComponent(search)}`;
    case 'voices':
      return `/api/admin/voices?page=${page}&limit=${PAGE_SIZE}`;
    case 'plans':
      return '/api/admin/plans';
    default:
      return '/api/admin/overview';
  }
}

/** Integer paise on the server; this division is the display boundary. */
function formatMoney(paise) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100);
}

function formatWhen(value) {
  if (!value) return '—';

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function Metric({ label, value, tone }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={tone === 'bad' ? 'history-bad' : undefined}>{value}</dd>
    </div>
  );
}

/** A {name: count} tally as a definition list, or a dash when there is nothing. */
function Tally({ rows }) {
  const entries = Object.entries(rows ?? {});

  if (entries.length === 0) return <p className="form-hint">Nothing recorded.</p>;

  return (
    <dl className="balance-split">
      {entries.map(([name, count]) => (
        <Metric key={name} label={name.replaceAll('_', ' ')} value={count.toLocaleString()} />
      ))}
    </dl>
  );
}

export function AdminPage() {
  const { user } = useAuth();

  const [view, setView] = useState('overview');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');

  const [data, setData] = useState(null);
  const [state, setState] = useState({ status: 'loading', message: '', forbidden: false });

  const load = useCallback(async () => {
    setState({ status: 'loading', message: '', forbidden: false });

    try {
      const response = await api.get(pathFor(view, { page, search }));

      // Tagged with the view it came from. Each view has a different shape, and
      // clicking a tab changes `view` before this runs - so untagged data would be
      // read with the wrong shape for a frame.
      setData({ view, payload: response.data });
      setState({ status: 'ready', message: '', forbidden: false });
    } catch (error) {
      setState({
        status: 'failed',
        message: toFormMessage(error),
        // 403 is the expected failure here, not a fault - so it gets its own
        // explanation rather than being shown as a generic error.
        forbidden: error.status === 403,
      });
    }
  }, [view, page, search]);

  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect
    load();
  }, [load]);

  function changeView(next) {
    setView(next);
    setPage(1);
  }

  function handleSearch(event) {
    event.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  // The loaded payload, but only while it belongs to the tab that is selected now.
  // Every view returns a different shape, so rendering last tab's payload under this
  // tab's markup is a blank page, not a flicker.
  const shown = data?.view === view ? data.payload : null;
  const pagination = shown?.pagination ?? null;

  return (
    <main className="shell shell-wide">
      <header className="header header-row">
        <div>
          <h1>Admin</h1>
          <p className="subtitle">Read-only. Nothing on this page writes anything.</p>
        </div>
        <div className="header-actions">
          <Link className="download" to="/dashboard">
            Back to studio
          </Link>
          <button type="button" onClick={load} disabled={state.status === 'loading'}>
            Refresh
          </button>
        </div>
      </header>

      <nav className="tabs">
        {VIEWS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            className={entry.key === view ? 'tab tab-on' : 'tab'}
            onClick={() => changeView(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {state.status === 'loading' ? <p className="form-note">Loading…</p> : null}

      {state.status === 'failed' ? (
        <section className="card stack">
          {state.forbidden ? (
            <>
              <p className="form-error">{state.message}</p>
              <p className="form-hint">
                {user.email} has the role <code>{user.role}</code>. There is no endpoint that
                promotes an account - deliberately - so this is changed in the database:
                <code>
                  db.users.updateOne({'{'}email:&quot;{user.email}&quot;{'}'},{'{'}$set:{'{'}
                  role:&quot;admin&quot;{'}'}
                  {'}'})
                </code>
                . The role is read from the database on every request, so it takes effect at once.
              </p>
            </>
          ) : (
            <>
              <p className="form-error">{state.message}</p>
              <button type="button" className="retry" onClick={load}>
                Try again
              </button>
            </>
          )}
        </section>
      ) : null}

      {state.status === 'ready' && view === 'overview' && shown ? (
        <>
          <section className="card stack">
            <div className="card-head">
              <h2>Money</h2>
              <span className="form-hint">Only paid orders count as revenue.</span>
            </div>
            <dl className="balance-split">
              <Metric label="Revenue" value={formatMoney(shown.payments.revenuePaise)} />
              <Metric label="Credits sold" value={shown.payments.creditsSold.toLocaleString()} />
              <Metric
                label="Paid, not credited"
                value={shown.payments.paidButUncredited.toLocaleString()}
                // The one number on this page that describes a user who is out of
                // pocket: the money arrived and the credits did not.
                tone={shown.payments.paidButUncredited > 0 ? 'bad' : undefined}
              />
              <Metric label="Live subscriptions" value={shown.subscriptions.live.toLocaleString()} />
            </dl>
            {shown.payments.paidButUncredited > 0 ? (
              <p className="form-error">
                {shown.payments.paidButUncredited} paid order(s) have no credits against them. That
                means a webhook never landed or its handler failed every retry - check the webhook
                deliveries below.
              </p>
            ) : null}
          </section>

          <section className="card stack">
            <div className="card-head">
              <h2>Accounts</h2>
            </div>
            <dl className="balance-split">
              <Metric label="Users" value={shown.users.total.toLocaleString()} />
              <Metric label="Verified" value={shown.users.verified.toLocaleString()} />
              <Metric label="Unverified" value={shown.users.unverified.toLocaleString()} />
              <Metric label="Generations" value={shown.generations.total.toLocaleString()} />
            </dl>
          </section>

          <section className="card stack">
            <div className="card-head">
              <h2>Orders by status</h2>
            </div>
            <Tally rows={shown.payments.byStatus} />

            <div className="card-head">
              <h2>Subscriptions by status</h2>
            </div>
            <Tally rows={shown.subscriptions.byStatus} />

            <div className="card-head">
              <h2>Generations by status</h2>
            </div>
            <Tally rows={shown.generations.byStatus} />
          </section>

          <section className="card stack">
            <div className="card-head">
              <h2>Credit ledger by type</h2>
              <span className="form-hint">Signed, so charges are negative.</span>
            </div>
            {Object.keys(shown.credits.byType).length === 0 ? (
              <p className="form-hint">Nothing recorded.</p>
            ) : (
              <dl className="balance-split">
                {Object.entries(shown.credits.byType).map(([type, row]) => (
                  <Metric
                    key={type}
                    label={`${type.replaceAll('_', ' ')} (${row.entries})`}
                    value={row.credits.toLocaleString()}
                  />
                ))}
              </dl>
            )}
          </section>

          <section className="card stack">
            <div className="card-head">
              <h2>Recent webhook deliveries</h2>
              <span className="form-hint">Last 20.</span>
            </div>

            {shown.webhooks.length === 0 ? (
              <p className="form-note">No provider webhooks have arrived yet.</p>
            ) : (
              <ul className="history">
                {shown.webhooks.map((row) => (
                  <li key={row.id} className="history-row">
                    <p className="history-text">
                      {row.event} · {row.status}
                    </p>
                    <p className="history-meta">
                      <span>{formatWhen(row.createdAt)}</span>
                      {/* Above 1 means the provider retried, which usually means our
                          first attempt failed. */}
                      <span className={row.attempts > 1 ? 'history-bad' : undefined}>
                        {row.attempts} attempt(s)
                      </span>
                      {row.subjectId ? <span>{row.subjectId}</span> : null}
                      <span>processed {formatWhen(row.processedAt)}</span>
                    </p>
                    {row.error ? <p className="form-error">{row.error}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}

      {state.status === 'ready' && view === 'users' && shown ? (
        <section className="card stack">
          <div className="card-head">
            <h2>Users · {shown.pagination.total.toLocaleString()}</h2>
          </div>

          <form className="form search-row" onSubmit={handleSearch}>
            <input
              type="search"
              value={searchInput}
              placeholder="Search by email"
              onChange={(event) => setSearchInput(event.target.value)}
            />
            <button type="submit">Search</button>
            {search ? (
              <button
                type="button"
                onClick={() => {
                  setSearchInput('');
                  setSearch('');
                  setPage(1);
                }}
              >
                Clear
              </button>
            ) : null}
          </form>

          {shown.users.length === 0 ? (
            <p className="form-note">No users match that search.</p>
          ) : (
            <ul className="history">
              {shown.users.map((row) => (
                <li key={row.id} className="history-row">
                  <p className="history-text">
                    {row.email} · {row.name}
                  </p>
                  <p className="history-meta">
                    <span className={row.role === 'admin' ? 'tag tag-good' : 'tag tag-muted'}>
                      {row.role}
                    </span>
                    <span className={row.emailVerified ? undefined : 'history-bad'}>
                      {row.emailVerified ? 'verified' : 'unverified'}
                    </span>
                    <span>{row.planSlug}</span>
                    <span>{row.credits.total.toLocaleString()} credits</span>
                    <span>joined {formatWhen(row.createdAt)}</span>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {state.status === 'ready' && view === 'plans' && shown ? (
        <section className="card stack">
          <div className="card-head">
            <h2>Plans · {shown.plans.length}</h2>
            <span className="form-hint">Including inactive ones.</span>
          </div>

          <ul className="history">
            {shown.plans.map((plan) => (
              <li key={plan.slug} className="history-row">
                <p className="history-text">
                  {plan.name} · {plan.slug}
                </p>
                <p className="history-meta">
                  <span>{plan.kind}</span>
                  <span>{plan.credits.toLocaleString()} credits</span>
                  <span>{formatMoney(plan.pricePaise)}</span>
                  {/* Guarded: an upsert does not run `required`, so a plan seeded
                      before that was enforced can be missing its cap. Saying nothing
                      is better than blanking the page. */}
                  {plan.maxCharsPerRequest ? (
                    <span>{plan.maxCharsPerRequest.toLocaleString()} chars/request</span>
                  ) : (
                    <span className="history-bad">no maxCharsPerRequest</span>
                  )}
                  <span>renewal: {plan.creditRenewalPolicy.replaceAll('_', ' ')}</span>
                  <span>GST: {plan.gstIncluded === null ? 'undecided' : String(plan.gstIncluded)}</span>
                  {plan.isActive ? null : <span className="history-bad">inactive</span>}
                  {/* The single most common reason a subscribe button 409s. */}
                  {plan.kind === 'subscription' && !plan.providerPlanId ? (
                    <span className="history-bad">no providerPlanId</span>
                  ) : null}
                  {plan.providerPlanId ? <span>{plan.providerPlanId}</span> : null}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {state.status === 'ready' && view === 'voices' && shown ? (
        <section className="card stack">
          <div className="card-head">
            <h2>Voices · {shown.pagination.total.toLocaleString()}</h2>
            <span className="form-hint">Retired voices are listed too.</span>
          </div>

          <ul className="history">
            {shown.voices.map((voice) => (
              <li key={voice.id} className="history-row">
                <p className="history-text">
                  {voice.name} · {voice.languageName}
                </p>
                <p className="history-meta">
                  <span>{voice.provider}</span>
                  <span>{voice.languageCode}</span>
                  <span>{voice.gender}</span>
                  <span>{voice.tier}</span>
                  <span>×{voice.costMultiplier}</span>
                  {voice.isActive ? null : <span className="history-bad">retired</span>}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {state.status === 'ready' && pagination && pagination.totalPages > 1 ? (
        <div className="pager">
          <button type="button" disabled={pagination.page <= 1} onClick={() => setPage(page - 1)}>
            ← Previous
          </button>
          <span className="form-hint">
            Page {pagination.page} of {pagination.totalPages}
          </span>
          <button
            type="button"
            disabled={pagination.page >= pagination.totalPages}
            onClick={() => setPage(page + 1)}
          >
            Next →
          </button>
        </div>
      ) : null}

      <footer className="footer">
        Everything here is a count or a record, never a control. Changing a price, a cost multiplier
        or a role is a database change on purpose - it leaves a trace and cannot be done with a
        stolen session.
      </footer>
    </main>
  );
}
