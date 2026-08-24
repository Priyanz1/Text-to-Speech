import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { env } from '../../config/env.js';

/**
 * A local stand-in for Razorpay.
 *
 * The point is that everything downstream of the provider is real: an order row,
 * a Checkout-shaped signature, a webhook envelope signed with the secret the
 * server verifies against, one ledger row, one balance change, and the same
 * idempotency guard on a replay. The only thing that does not happen is money
 * moving.
 *
 * That matters because the interesting bugs in billing are all on our side of
 * the boundary - a double grant, a missing idempotency key, a webhook processed
 * twice - and none of them need a real payment to reproduce. It also means the
 * whole billing surface is demonstrable before a Razorpay account exists, which
 * is the same reason integrations/ttsProvider has a mock.
 *
 * It is obviously not real: every id is prefixed `mock_`. A convincing mock is
 * one you ship by accident.
 */

/**
 * Secrets for signing, derived rather than hard-coded.
 *
 * Falling back to JWT_SECRET (which is required, has no default, and is unique
 * per environment) means there is no literal secret in this file and no shared
 * value that would let one developer's mock signature validate on another's
 * machine. If real Razorpay secrets happen to be set, those are used instead, so
 * flipping PAYMENT_PROVIDER back and forth does not invalidate anything.
 */
const paymentSecret = () => env.RAZORPAY_KEY_SECRET || env.JWT_SECRET;
const webhookSecret = () => env.RAZORPAY_WEBHOOK_SECRET || env.JWT_SECRET;

function signaturesMatch(expected, received) {
  if (typeof received !== 'string' || received.length !== expected.length) return false;

  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(received, 'utf8'));
}

const mockId = (prefix) => `mock_${prefix}_${randomUUID().replaceAll('-', '').slice(0, 14)}`;

// --- orders ----------------------------------------------------------------

export async function createOrder({ amountPaise, currency }) {
  return {
    providerOrderId: mockId('order'),
    amountPaise,
    currency,
    status: 'created',
  };
}

export function verifyPaymentSignature({ orderId, paymentId, signature }) {
  const expected = createHmac('sha256', paymentSecret())
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  return signaturesMatch(expected, signature);
}

// --- subscriptions ---------------------------------------------------------

export async function createSubscription({ providerPlanId, totalCount }) {
  const now = Date.now();
  const cycle = 30 * 24 * 60 * 60 * 1_000;

  return {
    providerSubscriptionId: mockId('sub'),
    providerPlanId,
    status: 'created',
    shortUrl: null,
    currentStart: new Date(now),
    currentEnd: new Date(now + cycle),
    chargeAt: new Date(now),
    endedAt: null,
    paidCount: 0,
    totalCount,
  };
}

export async function fetchSubscription(providerSubscriptionId) {
  // No provider-side state to read back. Our own Subscription document is what
  // the UI renders, and the webhook handler is what keeps it current.
  return {
    providerSubscriptionId,
    providerPlanId: null,
    status: 'active',
    shortUrl: null,
    currentStart: null,
    currentEnd: null,
    chargeAt: null,
    endedAt: null,
    paidCount: 0,
    totalCount: null,
  };
}

export async function cancelSubscription(providerSubscriptionId, { atCycleEnd = true } = {}) {
  // Mirrors Razorpay: cancelling at cycle end leaves the subscription active
  // until the paid-for period runs out, so the status does not change yet.
  return {
    providerSubscriptionId,
    providerPlanId: null,
    status: atCycleEnd ? 'active' : 'cancelled',
    shortUrl: null,
    currentStart: null,
    currentEnd: null,
    chargeAt: null,
    endedAt: atCycleEnd ? null : new Date(),
    paidCount: 0,
    totalCount: null,
  };
}

export async function resumeSubscription(providerSubscriptionId) {
  return {
    providerSubscriptionId,
    providerPlanId: null,
    status: 'active',
    shortUrl: null,
    currentStart: null,
    currentEnd: null,
    chargeAt: null,
    endedAt: null,
    paidCount: 0,
    totalCount: null,
  };
}

export function verifySubscriptionSignature({ paymentId, subscriptionId, signature }) {
  const expected = createHmac('sha256', paymentSecret())
    .update(`${paymentId}|${subscriptionId}`)
    .digest('hex');

  return signaturesMatch(expected, signature);
}

// --- webhooks --------------------------------------------------------------

export function verifyWebhookSignature({ rawBody, signature }) {
  const expected = createHmac('sha256', webhookSecret()).update(rawBody).digest('hex');

  return signaturesMatch(expected, signature);
}

/**
 * Signs a webhook body, so a simulated payment can be delivered through the real
 * endpoint rather than around it.
 *
 * Only the mock adapter has this. The dev "simulate payment" button and the test
 * suite both use it to POST a properly signed event to /api/webhooks/razorpay,
 * which means the signature check, the replay guard and the grant are all the
 * production code paths - not a shortcut that skips them.
 */
export function signWebhook(rawBody) {
  return createHmac('sha256', webhookSecret()).update(rawBody).digest('hex');
}

/** Builds a Checkout-shaped payment id and signature for a simulated payment. */
export function simulateCheckout({ orderId }) {
  const paymentId = mockId('pay');

  return {
    paymentId,
    signature: createHmac('sha256', paymentSecret())
      .update(`${orderId}|${paymentId}`)
      .digest('hex'),
  };
}

export function describe() {
  return 'mock (no money moves; every id is prefixed mock_)';
}

// Deliberately blank. The client uses this to decide whether to open Razorpay
// Checkout or show the simulate button, so an invented key id here would make it
// try to open Checkout and fail.
export const publicKeyId = '';
