import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import mongoose from 'mongoose';

import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import * as payments from '../../integrations/payments/index.js';
import { Token } from '../auth/token.model.js';
import { CreditTransaction } from '../credits/creditTransaction.model.js';
import { reconcile } from '../credits/credits.service.js';
import { PLAN_KINDS, Plan } from '../plans/plan.model.js';
import { User } from '../users/user.model.js';

import { ORDER_STATUS, PaymentOrder } from './paymentOrder.model.js';
import { SUBSCRIPTION_STATUS, Subscription } from './subscription.model.js';
import { WebhookEvent } from './webhookEvent.model.js';

/**
 * End-to-end billing tests over real HTTP, against a real MongoDB and the mock
 * payment provider.
 *
 * The mock is not a shortcut around the code under test. It signs its webhooks with
 * the same secret the server verifies against, so every event below travels through
 * the real signature check, the real replay guard and the real credit ledger. What
 * is being tested is the thing that actually matters in billing: that money becomes
 * credits exactly once.
 *
 * Its own database, because `node --test` runs files in parallel processes.
 */
const TEST_DB = 'tts-saas-test-billing';

let dbError = null;
try {
  await mongoose.connect(env.MONGODB_URI, { dbName: TEST_DB, serverSelectionTimeoutMS: 3_000 });
} catch (error) {
  dbError = error.message;
}

const skip = dbError
  ? `MongoDB is not reachable (${dbError})`
  : payments.isMock
    ? false
    : 'PAYMENT_PROVIDER is not mock; refusing to run billing tests against a real provider';

let server;
let baseUrl;

const FREE_PLAN = {
  slug: 'test-free',
  name: 'Test Free',
  kind: PLAN_KINDS.FREE,
  credits: 100,
  maxCharsPerRequest: 200,
  pricePaise: 0,
  allowedVoiceTiers: [],
};

const PACK = {
  slug: 'test-pack',
  name: 'Test pack',
  kind: PLAN_KINDS.CREDIT_PACK,
  credits: 1_000,
  maxCharsPerRequest: 500,
  // Integer paise, as everything money-shaped in this codebase is.
  pricePaise: 9_900,
  allowedVoiceTiers: [],
};

const UNPRICED_PACK = {
  slug: 'test-pack-unpriced',
  name: 'Unpriced pack',
  kind: PLAN_KINDS.CREDIT_PACK,
  credits: 500,
  maxCharsPerRequest: 500,
  pricePaise: 0,
  allowedVoiceTiers: [],
};

const SUBSCRIPTION_PLAN = {
  slug: 'test-sub',
  name: 'Test subscription',
  kind: PLAN_KINDS.SUBSCRIPTION,
  credits: 2_000,
  maxCharsPerRequest: 1_000,
  pricePaise: 29_900,
  providerPlanId: 'plan_mock_for_tests',
  allowedVoiceTiers: [],
};

const UNLINKED_SUBSCRIPTION = {
  slug: 'test-sub-unlinked',
  name: 'Unlinked subscription',
  kind: PLAN_KINDS.SUBSCRIPTION,
  credits: 2_000,
  maxCharsPerRequest: 1_000,
  pricePaise: 29_900,
  allowedVoiceTiers: [],
};

before(async () => {
  if (skip) return;

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (skip) return;

  await Promise.all([
    User.deleteMany({}),
    Token.deleteMany({}),
    Plan.deleteMany({}),
    CreditTransaction.deleteMany({}),
    PaymentOrder.deleteMany({}),
    Subscription.deleteMany({}),
    WebhookEvent.deleteMany({}),
  ]);
});

after(async () => {
  if (dbError) {
    await mongoose.disconnect().catch(() => {});
    return;
  }

  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();

  if (server) {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
});

// --- helpers ---------------------------------------------------------------

const CREDENTIALS = {
  name: 'Billing Tester',
  email: 'billing@example.com',
  password: 'correct horse battery staple',
};

async function call(path, { method = 'POST', body, token } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  return { status: response.status, headers: response.headers, body: await response.json() };
}

/** POSTs a raw, signed body to the webhook endpoint, exactly as Razorpay would. */
async function postWebhook(rawBody, { signature, eventId } = {}) {
  const response = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Razorpay-Signature': signature ?? payments.signWebhook(rawBody),
      ...(eventId ? { 'X-Razorpay-Event-Id': eventId } : {}),
    },
    body: rawBody,
  });

  return { status: response.status, body: await response.json() };
}

async function captureEmailedToken(fn) {
  const original = process.stdout.write.bind(process.stdout);
  let captured = '';

  process.stdout.write = (chunk, ...rest) => {
    captured += chunk;
    return original(chunk, ...rest);
  };

  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }

  return captured.match(/token=([A-Za-z0-9_-]{20,})/)?.[1] ?? null;
}

async function seedPlans() {
  await Plan.create([FREE_PLAN, PACK, UNPRICED_PACK, SUBSCRIPTION_PLAN, UNLINKED_SUBSCRIPTION]);
}

async function signedInUser(email = CREDENTIALS.email) {
  const credentials = { ...CREDENTIALS, email };

  const token = await captureEmailedToken(() => call('/api/auth/signup', { body: credentials }));
  await call('/api/auth/verify-email', { body: { token } });

  const login = await call('/api/auth/login', { body: credentials });

  return { accessToken: login.body.data.accessToken, user: login.body.data.user };
}

async function balanceOf(userId) {
  const user = await User.findById(userId).lean();

  return {
    subscription: user.subscriptionCredits,
    purchased: user.purchasedCredits,
    total: user.subscriptionCredits + user.purchasedCredits,
  };
}

/** Buys a pack up to (but not including) the webhook. */
async function createOrder(accessToken, planSlug = PACK.slug) {
  const response = await call('/api/billing/orders', { token: accessToken, body: { planSlug } });

  assert.equal(response.status, 201, `order failed: ${JSON.stringify(response.body)}`);

  return response.body.data.order;
}

function subscriptionEvent(event, { providerSubscriptionId, paymentId = null, paidCount = 1 }) {
  const now = Math.floor(Date.UTC(2026, 0, 1) / 1_000);

  return JSON.stringify({
    entity: 'event',
    event,
    contains: paymentId ? ['subscription', 'payment'] : ['subscription'],
    payload: {
      subscription: {
        entity: {
          id: providerSubscriptionId,
          status: 'active',
          current_start: now,
          current_end: now + 30 * 24 * 60 * 60,
          charge_at: now + 30 * 24 * 60 * 60,
          paid_count: paidCount,
        },
      },
      ...(paymentId
        ? { payment: { entity: { id: paymentId, amount: SUBSCRIPTION_PLAN.pricePaise } } }
        : {}),
    },
  });
}

// --- catalog ---------------------------------------------------------------

describe('GET /api/billing/catalog', { skip }, () => {
  it('lists priced packs and subscriptions, and says which provider is live', async () => {
    await seedPlans();
    const { accessToken } = await signedInUser();

    const response = await call('/api/billing/catalog', { method: 'GET', token: accessToken });

    assert.equal(response.status, 200);

    const { packs, subscriptions, isMock, currency, keyId } = response.body.data;

    assert.equal(currency, 'INR');
    assert.equal(isMock, true);
    // Blank in mock mode, which is how the client knows to show the simulate
    // button instead of trying to open Checkout.
    assert.equal(keyId, '');

    const pack = packs.find((entry) => entry.slug === PACK.slug);
    assert.equal(pack.pricePaise, PACK.pricePaise);
    assert.equal(pack.credits, PACK.credits);
    assert.equal(pack.isPurchasable, true);

    // A pack with no price is listed but not purchasable, rather than hidden -
    // hiding it makes a misconfigured plan invisible.
    assert.equal(packs.find((entry) => entry.slug === UNPRICED_PACK.slug).isPurchasable, false);

    // A subscription with no providerPlanId cannot be bought, and says so.
    assert.equal(
      subscriptions.find((entry) => entry.slug === SUBSCRIPTION_PLAN.slug).isPurchasable,
      true,
    );
    assert.equal(
      subscriptions.find((entry) => entry.slug === UNLINKED_SUBSCRIPTION.slug).isPurchasable,
      false,
    );

    // The free plan is not on sale.
    assert.equal(packs.some((entry) => entry.slug === FREE_PLAN.slug), false);
  });

  it('requires authentication', async () => {
    const response = await call('/api/billing/catalog', { method: 'GET' });

    assert.equal(response.status, 401);
  });
});

// --- orders ----------------------------------------------------------------

describe('POST /api/billing/orders', { skip }, () => {
  it('creates an order that snapshots the price and grants nothing', async () => {
    await seedPlans();
    const { accessToken, user } = await signedInUser();

    const before = await balanceOf(user.id);
    const order = await createOrder(accessToken);

    assert.equal(order.status, ORDER_STATUS.CREATED);
    assert.equal(order.amountPaise, PACK.pricePaise);
    assert.equal(order.credits, PACK.credits);
    assert.equal(order.creditedAt, null);
    assert.match(order.providerOrderId, /^mock_order_/);

    // The whole point: creating an order moves no credits.
    assert.deepEqual(await balanceOf(user.id), before);
  });

  it('refuses an unknown plan, an unpriced plan, and a plan of the wrong kind', async () => {
    await seedPlans();
    const { accessToken } = await signedInUser();

    const unknown = await call('/api/billing/orders', {
      token: accessToken,
      body: { planSlug: 'no-such-pack' },
    });
    assert.equal(unknown.status, 404);

    const unpriced = await call('/api/billing/orders', {
      token: accessToken,
      body: { planSlug: UNPRICED_PACK.slug },
    });
    assert.equal(unpriced.status, 409);

    // A subscription is not a pack; asking for one here must not create an order.
    const wrongKind = await call('/api/billing/orders', {
      token: accessToken,
      body: { planSlug: SUBSCRIPTION_PLAN.slug },
    });
    assert.equal(wrongKind.status, 404);

    assert.equal(await PaymentOrder.countDocuments({}), 0);
  });
});

describe('POST /api/billing/orders/verify', { skip }, () => {
  it('records a verified payment without granting credits', async () => {
    await seedPlans();
    const { accessToken, user } = await signedInUser();
    const order = await createOrder(accessToken);

    const { checkout } = (
      await call(`/api/billing/orders/${order.providerOrderId}/simulate`, { token: accessToken })
    ).body.data;

    const before = await balanceOf(user.id);

    const response = await call('/api/billing/orders/verify', {
      token: accessToken,
      body: checkout,
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.verified, true);
    // Not credited: the webhook has not been delivered yet. This is the field the
    // UI uses to say "credits are on their way".
    assert.equal(response.body.data.credited, false);

    // The Checkout callback is not allowed to grant. If this ever passes with a
    // changed balance, the single most important rule in billing has been broken.
    assert.deepEqual(await balanceOf(user.id), before);

    const stored = await PaymentOrder.findOne({ providerOrderId: order.providerOrderId });
    assert.equal(stored.providerPaymentId, checkout.razorpay_payment_id);
    assert.equal(stored.status, ORDER_STATUS.CREATED);
  });

  it('rejects a forged signature', async () => {
    await seedPlans();
    const { accessToken } = await signedInUser();
    const order = await createOrder(accessToken);

    const response = await call('/api/billing/orders/verify', {
      token: accessToken,
      body: {
        razorpay_order_id: order.providerOrderId,
        razorpay_payment_id: 'mock_pay_forged00000',
        razorpay_signature: 'f'.repeat(64),
      },
    });

    assert.equal(response.status, 400);
  });

  it("refuses to touch another account's order", async () => {
    await seedPlans();
    const owner = await signedInUser('owner@example.com');
    const other = await signedInUser('other@example.com');

    const order = await createOrder(owner.accessToken);

    // 404 rather than 403, so this cannot be used to discover which order ids exist.
    const response = await call('/api/billing/orders/verify', {
      token: other.accessToken,
      body: {
        razorpay_order_id: order.providerOrderId,
        razorpay_payment_id: 'mock_pay_someoneelse',
        razorpay_signature: 'a'.repeat(64),
      },
    });

    assert.equal(response.status, 404);
  });
});

// --- the webhook: the only thing that grants ------------------------------

describe('POST /api/webhooks/razorpay (credit packs)', { skip }, () => {
  it('grants the order\'s snapshotted credits exactly once', async () => {
    await seedPlans();
    const { accessToken, user } = await signedInUser();
    const order = await createOrder(accessToken);

    const before = await balanceOf(user.id);

    const { webhook } = (
      await call(`/api/billing/orders/${order.providerOrderId}/simulate`, { token: accessToken })
    ).body.data;

    const first = await postWebhook(webhook.rawBody, {
      signature: webhook.signature,
      eventId: webhook.eventId,
    });

    assert.equal(first.status, 200);
    assert.equal(first.body.data.status, 'processed');

    const after = await balanceOf(user.id);
    // Purchased, not subscription: bought credits never expire, and crediting them
    // to the wrong bucket would quietly make them expirable.
    assert.equal(after.purchased, before.purchased + PACK.credits);
    assert.equal(after.subscription, before.subscription);

    const paid = await PaymentOrder.findOne({ providerOrderId: order.providerOrderId });
    assert.equal(paid.status, ORDER_STATUS.PAID);
    assert.notEqual(paid.creditedAt, null);

    const rows = await CreditTransaction.find({
      idempotencyKey: `purchase:${order.providerOrderId}`,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, PACK.credits);

    // The cached balance and the ledger must agree.
    assert.equal((await reconcile(user.id)).ok, true);
  });

  it('ignores a redelivery of the same event', async () => {
    await seedPlans();
    const { accessToken, user } = await signedInUser();
    const order = await createOrder(accessToken);

    const { webhook } = (
      await call(`/api/billing/orders/${order.providerOrderId}/simulate`, { token: accessToken })
    ).body.data;

    await postWebhook(webhook.rawBody, { signature: webhook.signature, eventId: webhook.eventId });
    const granted = await balanceOf(user.id);

    const replay = await postWebhook(webhook.rawBody, {
      signature: webhook.signature,
      eventId: webhook.eventId,
    });

    // 200, not an error: it is already done, and a non-2xx would make Razorpay
    // retry something that has already succeeded.
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.status, 'duplicate');

    assert.deepEqual(await balanceOf(user.id), granted);
    assert.equal(await CreditTransaction.countDocuments({ type: 'purchase' }), 1);

    const event = await WebhookEvent.findOne({ providerEventId: webhook.eventId });
    assert.equal(event.attempts, 2);
  });

  it('grants nothing twice when a second, different event names the same order', async () => {
    await seedPlans();
    const { accessToken, user } = await signedInUser();
    const order = await createOrder(accessToken);

    const { webhook } = (
      await call(`/api/billing/orders/${order.providerOrderId}/simulate`, { token: accessToken })
    ).body.data;

    await postWebhook(webhook.rawBody, { signature: webhook.signature, eventId: webhook.eventId });
    const granted = await balanceOf(user.id);

    /**
     * Razorpay sends both payment.captured and order.paid for one payment. They are
     * separate events with separate ids, so the replay guard cannot stop the second
     * - the PaymentOrder.creditedAt claim and the ledger's idempotencyKey are what
     * do, and this is the test that proves it.
     */
    const orderPaid = JSON.stringify({
      entity: 'event',
      event: 'order.paid',
      contains: ['order', 'payment'],
      payload: {
        order: { entity: { id: order.providerOrderId, amount: order.amountPaise } },
        payment: { entity: { id: 'mock_pay_second00000', order_id: order.providerOrderId } },
      },
    });

    const second = await postWebhook(orderPaid, { eventId: 'mock_evt_order_paid' });

    assert.equal(second.status, 200);
    assert.deepEqual(await balanceOf(user.id), granted);
    assert.equal(await CreditTransaction.countDocuments({ type: 'purchase' }), 1);
    assert.equal((await reconcile(user.id)).ok, true);
  });

  it('rejects an unsigned or wrongly signed body and grants nothing', async () => {
    await seedPlans();
    const { accessToken, user } = await signedInUser();
    const order = await createOrder(accessToken);

    const { webhook } = (
      await call(`/api/billing/orders/${order.providerOrderId}/simulate`, { token: accessToken })
    ).body.data;

    const before = await balanceOf(user.id);

    const forged = await postWebhook(webhook.rawBody, { signature: 'f'.repeat(64) });
    assert.equal(forged.status, 400);

    const unsigned = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: webhook.rawBody,
    });
    assert.equal(unsigned.status, 400);

    assert.deepEqual(await balanceOf(user.id), before);
    // Nothing was even claimed, because the signature check runs before any write.
    assert.equal(await WebhookEvent.countDocuments({}), 0);
  });

  it('detects a byte-identical replay even with no event id header', async () => {
    await seedPlans();
    const { accessToken, user } = await signedInUser();
    const order = await createOrder(accessToken);

    const { webhook } = (
      await call(`/api/billing/orders/${order.providerOrderId}/simulate`, { token: accessToken })
    ).body.data;

    await postWebhook(webhook.rawBody, { signature: webhook.signature });
    const granted = await balanceOf(user.id);

    // Same bytes, no id header: the fallback hash of the body collides.
    const replay = await postWebhook(webhook.rawBody, { signature: webhook.signature });

    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.status, 'duplicate');
    assert.deepEqual(await balanceOf(user.id), granted);
  });

  it('answers 200 and ignores an event for an order it does not know', async () => {
    await seedPlans();

    const stranger = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      contains: ['payment'],
      payload: { payment: { entity: { id: 'mock_pay_stranger000', order_id: 'mock_order_stranger' } } },
    });

    const response = await postWebhook(stranger, { eventId: 'mock_evt_stranger' });

    // 200 so Razorpay stops retrying. One test account shared between a laptop and
    // a staging deployment means each receives the other's webhooks, and that is
    // normal rather than an error.
    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, 'ignored');
    assert.equal(await CreditTransaction.countDocuments({}), 0);
  });

  it('records a failed payment without touching the balance', async () => {
    await seedPlans();
    const { accessToken, user } = await signedInUser();
    const order = await createOrder(accessToken);

    const before = await balanceOf(user.id);

    const failed = JSON.stringify({
      entity: 'event',
      event: 'payment.failed',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: 'mock_pay_failed0000',
            order_id: order.providerOrderId,
            error_description: 'The card was declined.',
          },
        },
      },
    });

    const response = await postWebhook(failed, { eventId: 'mock_evt_failed' });

    assert.equal(response.status, 200);

    const stored = await PaymentOrder.findOne({ providerOrderId: order.providerOrderId });
    assert.equal(stored.status, ORDER_STATUS.FAILED);
    assert.equal(stored.failureReason, 'The card was declined.');
    assert.deepEqual(await balanceOf(user.id), before);
  });

  it('does not walk a paid order backwards when a later attempt fails', async () => {
    await seedPlans();
    const { accessToken } = await signedInUser();
    const order = await createOrder(accessToken);

    const { webhook } = (
      await call(`/api/billing/orders/${order.providerOrderId}/simulate`, { token: accessToken })
    ).body.data;
    await postWebhook(webhook.rawBody, { signature: webhook.signature, eventId: webhook.eventId });

    const failed = JSON.stringify({
      entity: 'event',
      event: 'payment.failed',
      contains: ['payment'],
      payload: { payment: { entity: { id: 'mock_pay_late000000', order_id: order.providerOrderId } } },
    });

    await postWebhook(failed, { eventId: 'mock_evt_late_failure' });

    const stored = await PaymentOrder.findOne({ providerOrderId: order.providerOrderId });
    assert.equal(stored.status, ORDER_STATUS.PAID);
  });
});

// --- subscriptions ---------------------------------------------------------

describe('subscriptions', { skip }, () => {
  it('creates one, and refuses a second while it is live', async () => {
    await seedPlans();
    const { accessToken } = await signedInUser();

    const first = await call('/api/billing/subscriptions', {
      token: accessToken,
      body: { planSlug: SUBSCRIPTION_PLAN.slug },
    });

    assert.equal(first.status, 201);
    assert.equal(first.body.data.subscription.status, SUBSCRIPTION_STATUS.CREATED);
    assert.equal(first.body.data.subscription.creditsPerCycle, SUBSCRIPTION_PLAN.credits);
    assert.equal(first.body.data.subscription.amountPaise, SUBSCRIPTION_PLAN.pricePaise);

    const second = await call('/api/billing/subscriptions', {
      token: accessToken,
      body: { planSlug: SUBSCRIPTION_PLAN.slug },
    });

    // Two live subscriptions would grant two allowances a month.
    assert.equal(second.status, 409);
    assert.equal(await Subscription.countDocuments({}), 1);
  });

  it('refuses a plan with no provider plan id', async () => {
    await seedPlans();
    const { accessToken } = await signedInUser();

    const response = await call('/api/billing/subscriptions', {
      token: accessToken,
      body: { planSlug: UNLINKED_SUBSCRIPTION.slug },
    });

    assert.equal(response.status, 409);
    assert.match(response.body.error.message, /payment provider/i);
    assert.equal(await Subscription.countDocuments({}), 0);
  });

  it('grants one cycle of credits per charge, into the subscription bucket', async () => {
    await seedPlans();
    const { accessToken, user } = await signedInUser();

    const created = await call('/api/billing/subscriptions', {
      token: accessToken,
      body: { planSlug: SUBSCRIPTION_PLAN.slug },
    });
    const { providerSubscriptionId } = created.body.data.subscription;

    const before = await balanceOf(user.id);

    const firstCharge = subscriptionEvent('subscription.charged', {
      providerSubscriptionId,
      paymentId: 'mock_pay_cycle1',
      paidCount: 1,
    });

    const first = await postWebhook(firstCharge, { eventId: 'mock_evt_cycle1' });
    assert.equal(first.status, 200);
    assert.equal(first.body.data.status, 'processed');

    let after = await balanceOf(user.id);
    // Subscription bucket, which is the one a renewal policy could later expire.
    assert.equal(after.subscription, before.subscription + SUBSCRIPTION_PLAN.credits);
    assert.equal(after.purchased, before.purchased);

    let stored = await Subscription.findOne({ providerSubscriptionId });
    assert.equal(stored.status, SUBSCRIPTION_STATUS.ACTIVE);
    assert.equal(stored.cyclesPaid, 1);
    assert.notEqual(stored.lastChargedAt, null);

    // A second cycle is a different payment, so it grants again. A per-subscription
    // idempotency key would have granted month one and silently skipped every month
    // after it.
    const secondCharge = subscriptionEvent('subscription.charged', {
      providerSubscriptionId,
      paymentId: 'mock_pay_cycle2',
      paidCount: 2,
    });

    await postWebhook(secondCharge, { eventId: 'mock_evt_cycle2' });

    after = await balanceOf(user.id);
    assert.equal(after.subscription, before.subscription + SUBSCRIPTION_PLAN.credits * 2);

    stored = await Subscription.findOne({ providerSubscriptionId });
    assert.equal(stored.cyclesPaid, 2);

    // And a redelivery of cycle one grants nothing, even under a new event id.
    await postWebhook(firstCharge, { eventId: 'mock_evt_cycle1_again' });

    assert.equal((await balanceOf(user.id)).subscription, after.subscription);
    assert.equal((await reconcile(user.id)).ok, true);
  });

  it('mirrors the provider through pending, halted and cancelled', async () => {
    await seedPlans();
    const { accessToken } = await signedInUser();

    const created = await call('/api/billing/subscriptions', {
      token: accessToken,
      body: { planSlug: SUBSCRIPTION_PLAN.slug },
    });
    const { providerSubscriptionId } = created.body.data.subscription;

    const sequence = [
      ['subscription.activated', SUBSCRIPTION_STATUS.ACTIVE],
      ['subscription.pending', SUBSCRIPTION_STATUS.PENDING],
      ['subscription.halted', SUBSCRIPTION_STATUS.HALTED],
      ['subscription.cancelled', SUBSCRIPTION_STATUS.CANCELLED],
    ];

    for (const [index, [event, expected]] of sequence.entries()) {
      const response = await postWebhook(
        subscriptionEvent(event, { providerSubscriptionId }),
        { eventId: `mock_evt_state_${index}` },
      );

      assert.equal(response.status, 200, `${event} was not accepted`);

      const stored = await Subscription.findOne({ providerSubscriptionId });
      assert.equal(stored.status, expected, `${event} did not produce ${expected}`);
    }

    const cancelled = await Subscription.findOne({ providerSubscriptionId });
    assert.notEqual(cancelled.endedAt, null);
    assert.equal(cancelled.toPublicJSON().isLive, false);

    // A charge arriving for a cancelled subscription is not credited by status - the
    // handler grants on the event, so nothing here asserts otherwise; what matters
    // is that a cancelled subscription cannot be resumed.
    const resume = await call(`/api/billing/subscriptions/${providerSubscriptionId}/resume`, {
      token: accessToken,
    });
    assert.equal(resume.status, 409);
    assert.match(resume.body.error.message, /cannot be resumed/i);
  });

  it('cancels at cycle end by default, and can be resumed once paused', async () => {
    await seedPlans();
    const { accessToken } = await signedInUser();

    const created = await call('/api/billing/subscriptions', {
      token: accessToken,
      body: { planSlug: SUBSCRIPTION_PLAN.slug },
    });
    const { providerSubscriptionId } = created.body.data.subscription;

    const cancelled = await call(`/api/billing/subscriptions/${providerSubscriptionId}/cancel`, {
      token: accessToken,
      body: {},
    });

    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.data.subscription.cancelAtCycleEnd, true);
    // Still active: the user paid for this cycle and keeps it.
    assert.equal(cancelled.body.data.subscription.status, SUBSCRIPTION_STATUS.ACTIVE);

    await postWebhook(subscriptionEvent('subscription.paused', { providerSubscriptionId }), {
      eventId: 'mock_evt_paused',
    });

    const paused = await Subscription.findOne({ providerSubscriptionId });
    assert.equal(paused.status, SUBSCRIPTION_STATUS.PAUSED);
    assert.equal(paused.toPublicJSON().canResume, true);

    const resumed = await call(`/api/billing/subscriptions/${providerSubscriptionId}/resume`, {
      token: accessToken,
    });

    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.data.subscription.status, SUBSCRIPTION_STATUS.ACTIVE);
    // Resuming clears the pending cancellation, which is the point of resuming.
    assert.equal(resumed.body.data.subscription.cancelAtCycleEnd, false);
  });

  it("refuses to cancel another account's subscription", async () => {
    await seedPlans();
    const owner = await signedInUser('owner@example.com');
    const other = await signedInUser('other@example.com');

    const created = await call('/api/billing/subscriptions', {
      token: owner.accessToken,
      body: { planSlug: SUBSCRIPTION_PLAN.slug },
    });
    const { providerSubscriptionId } = created.body.data.subscription;

    const response = await call(`/api/billing/subscriptions/${providerSubscriptionId}/cancel`, {
      token: other.accessToken,
      body: {},
    });

    assert.equal(response.status, 404);
    assert.equal(
      (await Subscription.findOne({ providerSubscriptionId })).status,
      SUBSCRIPTION_STATUS.CREATED,
    );
  });
});

// --- history ---------------------------------------------------------------

describe('GET /api/billing/history', { skip }, () => {
  it("returns only the caller's payments and subscriptions", async () => {
    await seedPlans();
    const owner = await signedInUser('owner@example.com');
    const other = await signedInUser('other@example.com');

    await createOrder(owner.accessToken);
    await createOrder(other.accessToken);
    await call('/api/billing/subscriptions', {
      token: owner.accessToken,
      body: { planSlug: SUBSCRIPTION_PLAN.slug },
    });

    const response = await call('/api/billing/history', { method: 'GET', token: owner.accessToken });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.payments.length, 1);
    assert.equal(response.body.data.payments[0].planSlug, PACK.slug);
    assert.equal(response.body.data.subscriptions.length, 1);
  });
});
