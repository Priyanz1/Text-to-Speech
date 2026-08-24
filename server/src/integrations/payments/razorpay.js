import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from '../../config/env.js';

/**
 * Razorpay over its REST API.
 *
 * No `razorpay` SDK: it is a thin wrapper over the same HTTP calls made below,
 * and the same reasoning already applied to Google Text-to-Speech and to Resend.
 * Signature verification is HMAC-SHA256, which node:crypto already does.
 *
 * Test mode and live mode are the same code. The mode is a property of the key
 * pair (rzp_test_... vs rzp_live_...), not of any setting here, which is why
 * there is no TEST/LIVE flag to get out of step with the keys.
 */
const API_BASE = 'https://api.razorpay.com/v1';

/** Basic auth, per Razorpay's API. The secret never leaves this process. */
function authHeader() {
  const encoded = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString(
    'base64',
  );
  return `Basic ${encoded}`;
}

async function razorpayFetch(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: authHeader(),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    // Razorpay's own description is worth keeping verbatim: "The api key provided
    // is invalid" and "plan_id is not a valid id" are both setup problems, and
    // the wording is the fastest route to the fix.
    const detail = payload?.error?.description ?? `HTTP ${response.status}`;
    const error = new Error(`Razorpay refused the request (${response.status}): ${detail}`);
    error.providerCode = payload?.error?.code ?? null;
    error.statusCode = response.status;
    throw error;
  }

  return payload;
}

/**
 * Compares two signatures without leaking which byte differed through timing.
 *
 * A plain === on a hex string returns early at the first mismatch, and that
 * timing difference is enough to recover a signature one character at a time.
 * Length is checked first because timingSafeEqual throws on unequal lengths.
 */
function signaturesMatch(expected, received) {
  if (typeof received !== 'string' || received.length !== expected.length) return false;

  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(received, 'utf8'));
}

// --- orders (one-time credit packs) ----------------------------------------

export async function createOrder({ amountPaise, currency, receipt, notes }) {
  const order = await razorpayFetch('/orders', {
    method: 'POST',
    body: {
      // Integer paise. Razorpay's API is paise-only, which is the same reason
      // Plan.pricePaise is an integer: a float rupee amount is money that is
      // slightly wrong, which is worse than money that is missing.
      amount: amountPaise,
      currency,
      receipt,
      notes,
    },
  });

  return {
    providerOrderId: order.id,
    amountPaise: order.amount,
    currency: order.currency,
    status: order.status,
  };
}

/**
 * Checks the signature Checkout's handler returns after a card payment.
 *
 * This proves the browser is reporting a real payment rather than an invented
 * one - but it is NOT what grants credits. Only the webhook does that, because a
 * browser that closes between the charge and the handler would otherwise leave a
 * paid order ungranted.
 */
export function verifyPaymentSignature({ orderId, paymentId, signature }) {
  const expected = createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  return signaturesMatch(expected, signature);
}

// --- subscriptions ---------------------------------------------------------

export async function createSubscription({ providerPlanId, totalCount, notes }) {
  const subscription = await razorpayFetch('/subscriptions', {
    method: 'POST',
    body: {
      plan_id: providerPlanId,
      total_count: totalCount,
      // Razorpay emails the customer about the mandate and each charge. Ours is
      // not the only notification the user gets, and suppressing theirs would
      // mean a failed mandate goes unnoticed.
      customer_notify: 1,
      notes,
    },
  });

  return normaliseSubscription(subscription);
}

export async function fetchSubscription(providerSubscriptionId) {
  return normaliseSubscription(await razorpayFetch(`/subscriptions/${providerSubscriptionId}`));
}

/**
 * Cancels, by default at the end of the paid-for cycle.
 *
 * atCycleEnd is the honest default: the user has already paid for the credits
 * they are holding, and cancelling immediately would end the cycle they bought.
 */
export async function cancelSubscription(providerSubscriptionId, { atCycleEnd = true } = {}) {
  const subscription = await razorpayFetch(`/subscriptions/${providerSubscriptionId}/cancel`, {
    method: 'POST',
    body: { cancel_at_cycle_end: atCycleEnd ? 1 : 0 },
  });

  return normaliseSubscription(subscription);
}

/**
 * Resumes a paused subscription.
 *
 * Razorpay has no un-cancel: once a subscription reaches `cancelled` it is
 * terminal, and the user has to subscribe again. Resume applies to `paused`,
 * which is the state a cancel-at-cycle-end has not reached yet.
 */
export async function resumeSubscription(providerSubscriptionId) {
  const subscription = await razorpayFetch(`/subscriptions/${providerSubscriptionId}/resume`, {
    method: 'POST',
    body: { resume_at: 'now' },
  });

  return normaliseSubscription(subscription);
}

/** Razorpay's epoch seconds and snake_case, mapped once so nothing above sees them. */
function normaliseSubscription(subscription) {
  const toDate = (seconds) => (seconds ? new Date(seconds * 1_000) : null);

  return {
    providerSubscriptionId: subscription.id,
    providerPlanId: subscription.plan_id,
    status: subscription.status,
    shortUrl: subscription.short_url ?? null,
    currentStart: toDate(subscription.current_start),
    currentEnd: toDate(subscription.current_end),
    chargeAt: toDate(subscription.charge_at),
    endedAt: toDate(subscription.ended_at),
    paidCount: subscription.paid_count ?? 0,
    totalCount: subscription.total_count ?? null,
  };
}

/**
 * Checkout returns a different signature for subscriptions than for orders, and
 * the concatenation order is reversed. Getting it the wrong way round produces a
 * mismatch that looks exactly like a forged request, so the two live in separate
 * functions rather than one with a flag.
 */
export function verifySubscriptionSignature({ paymentId, subscriptionId, signature }) {
  const expected = createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${paymentId}|${subscriptionId}`)
    .digest('hex');

  return signaturesMatch(expected, signature);
}

// --- webhooks --------------------------------------------------------------

/**
 * The signature is over the EXACT bytes Razorpay sent.
 *
 * Not over a re-serialised object: JSON.stringify(JSON.parse(body)) reorders
 * nothing in V8 today but is not guaranteed to, and any difference in whitespace
 * or number formatting changes the hash. app.js therefore parses the webhook
 * path with express.raw, before express.json can touch it.
 */
export function verifyWebhookSignature({ rawBody, signature }) {
  const expected = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  return signaturesMatch(expected, signature);
}

export function describe() {
  // Only the id, never the secret. The id is public - the browser needs it to
  // open Checkout - and its prefix says whether this is test or live money.
  return `razorpay (${env.RAZORPAY_KEY_ID || 'no key id'})`;
}

export const publicKeyId = env.RAZORPAY_KEY_ID;
