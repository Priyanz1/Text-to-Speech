import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { env } from '../../config/env.js';
import { api } from '../../lib/apiClient.js';
import { toFormMessage } from '../../lib/formError.js';
import { useAuth } from '../auth/authContext.js';

/**
 * Buying credits, and the record of every attempt.
 *
 * The one rule this page is built around is the same one the server is built
 * around: THE WEBHOOK GRANTS THE CREDITS. Nothing the browser does here adds a
 * credit to anyone's balance. What the browser does is start an order, hand the
 * user to Checkout, and report back that Checkout said yes - and that report is
 * only ever used to show the user a reassuring message. The balance below changes
 * because the server was told by the payment provider, out of band, that money
 * arrived.
 *
 * That is why there are two paths through handleBuyPack and why the mock path is
 * the longer one. In mock mode the browser has to play Razorpay's part as well as
 * its own: it asks the server for a signed webhook envelope and POSTs it to the
 * real webhook endpoint. Nothing is skipped - the signature check, the replay
 * guard and the ledger's idempotency key are all the production code. The only
 * thing that does not happen is money moving.
 */
const CHECKOUT_SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';

/** Matches --accent in index.css, so Checkout does not look like a different app. */
const CHECKOUT_THEME_COLOUR = '#6c8cff';

const ORDER_TONE = { paid: 'good', failed: 'bad', created: 'muted' };

const SUBSCRIPTION_TONE = {
  active: 'good',
  pending: 'bad',
  halted: 'bad',
  created: 'muted',
  authenticated: 'muted',
  paused: 'muted',
  cancelled: 'muted',
  completed: 'muted',
  expired: 'muted',
};

/**
 * Paise are integers everywhere on the server, deliberately - 0.1 + 0.2 is not
 * 0.3, and money that is slightly wrong is worse than money that is missing. This
 * division is the only place in the app where money becomes a fraction, and it
 * happens at the display boundary and nowhere else.
 */
function formatMoney(paise, currency = 'INR') {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(paise / 100);
}

function formatWhen(value) {
  if (!value) return '—';

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function Tag({ tone, children }) {
  return <span className={`tag tag-${tone ?? 'muted'}`}>{children}</span>;
}

/**
 * Loads Razorpay's Checkout script, once per page.
 *
 * Not bundled: Razorpay require the live copy from their CDN so that fixes to the
 * payment dialog reach users without an app deploy, and a pinned copy of someone
 * else's payment UI is a liability. Loaded on demand rather than in index.html so
 * a user who never opens this page never fetches a third-party script - and so
 * the mock path has no third-party dependency at all.
 */
let checkoutScriptPromise = null;

function loadCheckoutScript() {
  if (window.Razorpay) return Promise.resolve();

  checkoutScriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');

    script.src = CHECKOUT_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      // Cleared so a later attempt can retry. A cached rejected promise would make
      // one flaky network moment permanent for the rest of the session.
      checkoutScriptPromise = null;
      reject(new Error('Could not load the payment dialog. Check your connection and try again.'));
    };

    document.head.append(script);
  });

  return checkoutScriptPromise;
}

/**
 * Delivers a simulated webhook. Development only - it needs the envelope the
 * server signed in simulatePackPayment, which does not exist in razorpay mode.
 *
 * Plain fetch rather than apiClient, for two reasons that both matter:
 *
 *   1. The body has to be the EXACT bytes the signature was computed over.
 *      apiClient JSON.stringify()s whatever it is given, which would re-encode an
 *      already-encoded string and fail verification - correctly.
 *   2. Razorpay does not send our Authorization header, so neither does this. The
 *      webhook's only authentication is the signature, and that is what should be
 *      exercised.
 */
async function deliverSimulatedWebhook({ rawBody, signature, eventId }) {
  const response = await fetch(`${env.apiBaseUrl}/api/webhooks/razorpay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Razorpay-Signature': signature,
      'X-Razorpay-Event-Id': eventId,
    },
    body: rawBody,
  });

  if (!response.ok) {
    throw new Error(
      `The simulated webhook was rejected with ${response.status}. The credits were not granted.`,
    );
  }

  return response.json();
}

export function BillingPage() {
  const { user, reloadUser } = useAuth();

  const [catalog, setCatalog] = useState(null);
  const [history, setHistory] = useState(null);
  const [state, setState] = useState({ status: 'loading', message: '' });

  // One thing at a time, keyed by whatever is being acted on, so a slow order does
  // not grey out the whole page and a double click cannot create two orders.
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);

  const credits = {
    total: user.credits?.total ?? 0,
    subscription: user.credits?.subscription ?? 0,
    purchased: user.credits?.purchased ?? 0,
  };

  // --- loading -------------------------------------------------------------

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setState({ status: 'loading', message: '' });

    try {
      const [catalogResponse, historyResponse] = await Promise.all([
        api.get('/api/billing/catalog'),
        api.get('/api/billing/history'),
      ]);

      setCatalog(catalogResponse.data);
      setHistory(historyResponse.data);
      setState({ status: 'ready', message: '' });
    } catch (error) {
      setState({ status: 'failed', message: toFormMessage(error) });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect
    load();
  }, [load]);

  /** Re-reads the balance and the history after money has moved. */
  const settle = useCallback(
    async (message) => {
      await Promise.all([reloadUser(), load({ quiet: true })]);
      setNotice({ tone: 'good', message });
    },
    [load, reloadUser],
  );

  // --- credit packs --------------------------------------------------------

  /**
   * Development path: the browser plays both parts.
   *
   * The order below mirrors production exactly - Checkout's callback reaches us
   * first and grants nothing, then the provider's webhook lands and is what
   * actually credits the account. Doing it in this order locally means the
   * "verified but not credited yet" state is a state you can actually see.
   */
  async function payWithSimulatedProvider(created) {
    const simulated = (
      await api.post(`/api/billing/orders/${created.order.providerOrderId}/simulate`)
    ).data;

    await api.post('/api/billing/orders/verify', simulated.checkout);
    await deliverSimulatedWebhook(simulated.webhook);

    await settle(
      'Payment simulated. The credits were granted by the webhook, through the same signature check, replay guard and ledger row that production uses.',
    );
  }

  /**
   * Production path: Razorpay's dialog.
   *
   * The promise is resolved by whichever of the three outcomes happens, so `busy`
   * stays set for exactly as long as the dialog is open. Without it the button
   * would re-enable behind the modal and a second click would create a second
   * order for the same purchase.
   */
  async function payWithCheckout(created) {
    await loadCheckoutScript();

    await new Promise((resolve) => {
      const checkout = new window.Razorpay({
        key: created.keyId,
        amount: created.order.amountPaise,
        currency: created.order.currency,
        order_id: created.order.providerOrderId,
        name: created.name,
        description: created.description,
        prefill: { email: user.email, name: user.name },
        theme: { color: CHECKOUT_THEME_COLOUR },

        handler: (response) => {
          // Verifies the signature and nothing else. The message says "on their
          // way" rather than "added" because at this instant they genuinely are:
          // the webhook is normally a second or two behind.
          api
            .post('/api/billing/orders/verify', response)
            .then(() =>
              settle(
                'Payment received. Your credits are added by the payment provider’s confirmation, which usually lands within a couple of seconds - use Refresh if the balance above still looks stale.',
              ),
            )
            .catch((error) => setNotice({ tone: 'bad', message: toFormMessage(error) }))
            .finally(resolve);
        },

        modal: {
          ondismiss: () => {
            setNotice({
              tone: 'muted',
              message: 'Checkout was closed, so nothing was charged. The order is left unpaid.',
            });
            resolve();
          },
        },
      });

      checkout.on('payment.failed', (event) => {
        setNotice({
          tone: 'bad',
          message:
            event?.error?.description ?? 'The payment did not go through. Nothing was charged.',
        });
        resolve();
      });

      checkout.open();
    });
  }

  async function handleBuyPack(pack) {
    setBusy(pack.slug);
    setNotice(null);

    try {
      const created = (await api.post('/api/billing/orders', { planSlug: pack.slug })).data;

      // isMock comes from the server, not from a build flag: which provider is in
      // use is a server-side fact, and the client should not have a second opinion.
      await (created.isMock ? payWithSimulatedProvider(created) : payWithCheckout(created));
    } catch (error) {
      setNotice({ tone: 'bad', message: toFormMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  // --- subscriptions -------------------------------------------------------

  async function handleSubscribe(plan) {
    setBusy(plan.slug);
    setNotice(null);

    try {
      const created = (await api.post('/api/billing/subscriptions', { planSlug: plan.slug })).data;

      await load({ quiet: true });

      if (created.shortUrl) {
        // Razorpay's hosted authorisation page. A subscription needs a mandate, not
        // a one-off payment, and their page is what collects it.
        window.open(created.shortUrl, '_blank', 'noopener,noreferrer');

        setNotice({
          tone: 'good',
          message:
            'Subscription created. Authorise the mandate in the tab that just opened; the first cycle is credited when the provider reports the charge.',
        });
      } else {
        setNotice({
          tone: 'muted',
          message:
            'Subscription created locally. There is no provider to authorise the mandate in mock mode, so it stays "created" and no cycle is charged - this is the part that needs real Razorpay keys.',
        });
      }
    } catch (error) {
      setNotice({ tone: 'bad', message: toFormMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function handleCancel(subscription, atCycleEnd) {
    setBusy(subscription.id);
    setNotice(null);

    try {
      const updated = (
        await api.post(`/api/billing/subscriptions/${subscription.providerSubscriptionId}/cancel`, {
          atCycleEnd,
        })
      ).data.subscription;

      await load({ quiet: true });

      setNotice({
        tone: 'muted',
        message: atCycleEnd
          ? 'Cancelled at the end of the current cycle. It stays usable until then, because that cycle is paid for.'
          : `Cancelled immediately. Status is now ${updated.status}, and a cancelled subscription cannot be resumed - subscribing again starts a new one.`,
      });
    } catch (error) {
      setNotice({ tone: 'bad', message: toFormMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function handleResume(subscription) {
    setBusy(subscription.id);
    setNotice(null);

    try {
      await api.post(
        `/api/billing/subscriptions/${subscription.providerSubscriptionId}/resume`,
        undefined,
      );

      await load({ quiet: true });
      setNotice({ tone: 'good', message: 'Subscription resumed. Charging continues as before.' });
    } catch (error) {
      setNotice({ tone: 'bad', message: toFormMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  // --- rendering -----------------------------------------------------------

  const isWorking = busy !== null;
  const packs = catalog?.packs ?? [];
  const subscriptionPlans = catalog?.subscriptions ?? [];
  const payments = history?.payments ?? [];
  const subscriptions = history?.subscriptions ?? [];
  const liveSubscription = subscriptions.find((row) => row.isLive) ?? null;

  return (
    <main className="shell shell-wide">
      <header className="header header-row">
        <div>
          <h1>Billing</h1>
          <p className="subtitle">Credits, subscriptions and everything you have been charged.</p>
        </div>
        <div className="header-actions">
          <Link className="download" to="/dashboard">
            Back to studio
          </Link>
          <button type="button" disabled={isWorking} onClick={() => load({ quiet: true })}>
            Refresh
          </button>
        </div>
      </header>

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
            <dd>{user.credits?.planSlug ?? user.planSlug}</dd>
          </div>
        </dl>
      </section>

      {notice ? (
        <p className={notice.tone === 'bad' ? 'form-error' : `form-note form-${notice.tone}`}>
          {notice.message}
        </p>
      ) : null}

      {state.status === 'loading' ? <p className="form-note">Loading the catalog…</p> : null}

      {state.status === 'failed' ? (
        <section className="card stack">
          <p className="form-error">{state.message}</p>
          <button type="button" className="retry" onClick={() => load()}>
            Try again
          </button>
        </section>
      ) : null}

      {state.status === 'ready' && catalog ? (
        <>
          {/* Which provider is live is worth stating on the page rather than only in
              a log: "why did nothing get charged" and "why is there no Checkout
              dialog" have the same one-word answer. */}
          {catalog.isMock ? (
            <section className="card notice">
              <div className="card-head">
                <h2>Simulated payments</h2>
                <Tag tone="muted">{catalog.provider}</Tag>
              </div>
              <p className="form-note">
                No money moves and no card is asked for. Buying a pack here creates a real order,
                signs a real webhook and grants real credits in this database, through exactly the
                code that runs in production. Every provider id is prefixed <code>mock_</code>.
              </p>
            </section>
          ) : null}

          <section className="card stack">
            <div className="card-head">
              <h2>Credit packs</h2>
              <span className="form-hint">One-off. Purchased credits never expire.</span>
            </div>

            {packs.length === 0 ? (
              <p className="form-note">
                No packs are on sale. Seed them with <code>npm run seed:billing</code> in the server
                package.
              </p>
            ) : (
              <ul className="plans">
                {packs.map((pack) => (
                  <li key={pack.slug} className="plan">
                    <div className="plan-head">
                      <span className="plan-name">{pack.name}</span>
                      <span className="plan-price">
                        {formatMoney(pack.pricePaise, catalog.currency)}
                      </span>
                    </div>

                    <p className="plan-credits">{pack.credits.toLocaleString()} credits</p>

                    {/* No per-request character cap is shown for a pack, on purpose:
                        buying one adds credits and leaves you on the plan you were
                        already on, so a cap printed here would promise something the
                        purchase does not actually buy. The cap belongs to the plan,
                        and it is shown on the subscriptions below - which do replace
                        it.

                        null GST is "undecided", which is not the same as "no GST", so
                        that says nothing rather than guessing. */}
                    {pack.gstIncluded === null ? null : (
                      <p className="plan-meta">
                        <span>{pack.gstIncluded ? 'GST included' : 'GST extra'}</span>
                      </p>
                    )}

                    {pack.isPurchasable ? (
                      <button
                        type="button"
                        className="primary"
                        disabled={isWorking}
                        onClick={() => handleBuyPack(pack)}
                      >
                        {busy === pack.slug ? 'Working…' : `Buy ${pack.credits.toLocaleString()}`}
                      </button>
                    ) : (
                      <span className="form-hint">No price set yet.</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card stack">
            <div className="card-head">
              <h2>Subscriptions</h2>
              <span className="form-hint">
                {liveSubscription ? 'One at a time. Cancel to switch.' : 'Credits every cycle.'}
              </span>
            </div>

            {subscriptionPlans.length === 0 ? (
              <p className="form-note">No subscriptions are on sale.</p>
            ) : (
              <ul className="plans">
                {subscriptionPlans.map((plan) => (
                  <li key={plan.slug} className="plan">
                    <div className="plan-head">
                      <span className="plan-name">{plan.name}</span>
                      <span className="plan-price">
                        {formatMoney(plan.pricePaise, catalog.currency)}
                      </span>
                    </div>

                    <p className="plan-credits">
                      {plan.credits.toLocaleString()} credits per cycle
                    </p>

                    <p className="plan-meta">
                      {/* A subscription does become your plan, so its cap is real
                          information here - guarded, because a plan seeded before the
                          field was enforced can still be missing it. */}
                      {plan.maxCharsPerRequest ? (
                        <span>
                          up to {plan.maxCharsPerRequest.toLocaleString()} chars per request
                        </span>
                      ) : null}
                      {/* Whether unused credits reset, roll over, or partly roll over
                          is still an open decision, so this reports the recorded
                          policy instead of implying one. */}
                      <span>renewal: {plan.creditRenewalPolicy.replaceAll('_', ' ')}</span>
                    </p>

                    {plan.isPurchasable ? (
                      <button
                        type="button"
                        className="primary"
                        disabled={isWorking || liveSubscription !== null}
                        onClick={() => handleSubscribe(plan)}
                      >
                        {busy === plan.slug ? 'Working…' : 'Subscribe'}
                      </button>
                    ) : (
                      <span className="form-hint">
                        Not connected to the payment provider yet.
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {liveSubscription ? (
              <p className="form-hint">
                You already have a {liveSubscription.status} subscription to{' '}
                {liveSubscription.planSlug}. Cancel it below before starting another.
              </p>
            ) : null}
          </section>

          {/* --- history ---------------------------------------------------- */}

          <section className="card stack">
            <div className="card-head">
              <h2>Subscriptions on this account</h2>
            </div>

            {subscriptions.length === 0 ? (
              <p className="form-note">No subscriptions yet.</p>
            ) : (
              <ul className="history">
                {subscriptions.map((row) => (
                  <li key={row.id} className="history-row">
                    <p className="history-text">
                      {row.planSlug} · {row.creditsPerCycle.toLocaleString()} credits per cycle ·{' '}
                      {formatMoney(row.amountPaise, row.currency)}
                    </p>

                    <p className="history-meta">
                      <Tag tone={SUBSCRIPTION_TONE[row.status]}>{row.status}</Tag>
                      <span>{row.cyclesPaid} cycle(s) paid</span>
                      <span>last charged {formatWhen(row.lastChargedAt)}</span>
                      {row.currentEnd ? <span>cycle ends {formatWhen(row.currentEnd)}</span> : null}
                      {row.cancelAtCycleEnd ? (
                        <span className="history-bad">cancels at cycle end</span>
                      ) : null}
                      <span>{row.providerSubscriptionId}</span>
                    </p>

                    {row.isLive || row.canResume ? (
                      <div className="history-actions">
                        {row.canResume ? (
                          <button
                            type="button"
                            disabled={isWorking}
                            onClick={() => handleResume(row)}
                          >
                            {busy === row.id ? 'Working…' : 'Resume'}
                          </button>
                        ) : null}

                        {row.isLive && !row.cancelAtCycleEnd ? (
                          <button
                            type="button"
                            disabled={isWorking}
                            onClick={() => handleCancel(row, true)}
                          >
                            {busy === row.id ? 'Working…' : 'Cancel at cycle end'}
                          </button>
                        ) : null}

                        {row.isLive ? (
                          <button
                            type="button"
                            className="danger"
                            disabled={isWorking}
                            onClick={() => handleCancel(row, false)}
                          >
                            {busy === row.id ? 'Working…' : 'Cancel now'}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card stack">
            <div className="card-head">
              <h2>
                Payments
                {payments.length > 0 ? ` · ${payments.length}` : ''}
              </h2>
              <span className="form-hint">Newest first, last 50.</span>
            </div>

            {payments.length === 0 ? (
              <p className="form-note">Nothing has been charged to this account yet.</p>
            ) : (
              <ul className="history">
                {payments.map((row) => (
                  <li key={row.id} className="history-row">
                    <p className="history-text">
                      {row.planSlug} · {row.credits.toLocaleString()} credits ·{' '}
                      {formatMoney(row.amountPaise, row.currency)}
                    </p>

                    <p className="history-meta">
                      <Tag tone={ORDER_TONE[row.status]}>{row.status}</Tag>
                      <span>{formatWhen(row.createdAt)}</span>
                      {/* Paid with no credited time is the one row worth chasing: the
                          money arrived and the credits did not. */}
                      {row.status === 'paid' && !row.creditedAt ? (
                        <span className="history-bad">paid, credits not granted yet</span>
                      ) : null}
                      {row.creditedAt ? <span>credited {formatWhen(row.creditedAt)}</span> : null}
                      <span>{row.providerOrderId}</span>
                    </p>

                    {row.failureReason ? <p className="form-error">{row.failureReason}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}

      <footer className="footer">
        Every price on this page is a placeholder until real figures are set on the plans. Credits
        are granted by the payment provider’s confirmation, never by this page - so if a payment
        shows as paid and the balance has not moved, that is a webhook to investigate, not a
        purchase to repeat.
      </footer>
    </main>
  );
}
