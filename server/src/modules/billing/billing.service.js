import { createHash, randomUUID } from 'node:crypto';

import { logger } from '../../config/logger.js';
import * as payments from '../../integrations/payments/index.js';
import { ApiError } from '../../utils/ApiError.js';
import { BUCKETS, LEDGER_TYPES } from '../credits/creditTransaction.model.js';
import { grantCredits } from '../credits/credits.service.js';
import { PLAN_KINDS, Plan } from '../plans/plan.model.js';

import { ORDER_STATUS, PaymentOrder } from './paymentOrder.model.js';
import {
  LIVE_SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_STATUS,
  Subscription,
} from './subscription.model.js';
import { WEBHOOK_STATUS, WebhookEvent } from './webhookEvent.model.js';

/**
 * Everything that turns money into credits.
 *
 * One rule governs this whole file, and it is worth stating before any of the
 * code: THE WEBHOOK IS THE ONLY THING THAT GRANTS CREDITS.
 *
 * Not the Checkout callback. The callback runs in the user's browser, and a
 * browser can close, lose its network, or be closed deliberately between the
 * charge and the callback - so a callback-driven grant loses credits the user paid
 * for. It can also be replayed, and a replayed grant is worse. What the callback
 * is good for is proving to the user, immediately, that the payment went through;
 * that is all confirmPayment does.
 *
 * Razorpay's webhook, by contrast, retries until it gets a 2xx. Combined with the
 * replay guard in webhookEvent.model.js and the ledger's unique idempotencyKey,
 * "at least once delivery" becomes "exactly once granted".
 */

/**
 * Razorpay accounts are single-currency, set when the account is created, so this
 * is not a pricing decision - it is a fact about the account. It lives here rather
 * than on Plan because a second currency would need a second Razorpay account, not
 * a second column.
 */
const CURRENCY = 'INR';

/**
 * How many billing cycles a subscription is created for.
 *
 * Razorpay requires a finite total_count. Ten years of monthly cycles is the
 * conventional way to say "until cancelled" - the subscription reaches `completed`
 * long after any realistic churn, and the user can cancel at any point.
 */
const SUBSCRIPTION_TOTAL_COUNT = 120;

/** A row stuck in `processing` for longer than this is a died-mid-handling leftover. */
const PROCESSING_GRACE_MS = 2 * 60_000;

const MAX_HISTORY = 50;

// --- catalog ---------------------------------------------------------------

/**
 * What is on sale, and what the browser needs to open Checkout.
 *
 * The prices come from the Plan collection, which is where they belong: they are
 * business numbers, and a business number in code needs a deploy to change. Every
 * price seeded so far is a PLACEHOLDER - see scripts/seed-billing.js.
 */
export async function getCatalog() {
  const plans = await Plan.find({
    isActive: true,
    kind: { $in: [PLAN_KINDS.CREDIT_PACK, PLAN_KINDS.SUBSCRIPTION] },
  }).sort({ kind: 1, pricePaise: 1 });

  return {
    packs: plans.filter((plan) => plan.kind === PLAN_KINDS.CREDIT_PACK).map(toCatalogEntry),
    subscriptions: plans
      .filter((plan) => plan.kind === PLAN_KINDS.SUBSCRIPTION)
      .map(toCatalogEntry),
    provider: payments.providerName,
    // The key id is public - Checkout needs it in the browser. Returned from here
    // rather than baked into the client bundle so there is one source of truth and
    // switching test keys for live keys is a server-side change only.
    keyId: payments.publicKeyId,
    isMock: payments.isMock,
    currency: CURRENCY,
  };
}

function toCatalogEntry(plan) {
  return {
    ...plan.toPublicJSON(),
    // A subscription cannot be bought until someone has created the matching plan
    // in the Razorpay dashboard and put its id here. Exposed so the UI can say
    // "not configured yet" instead of offering a button that 400s.
    isPurchasable:
      plan.pricePaise > 0 &&
      (plan.kind !== PLAN_KINDS.SUBSCRIPTION || Boolean(plan.providerPlanId)),
    // Still open in DECISIONS.md §4, so it is reported as unknown rather than
    // assumed either way.
    gstIncluded: plan.gstIncluded,
    creditRenewalPolicy: plan.creditRenewalPolicy,
  };
}

/** Loads a plan for purchase, or explains exactly why it cannot be bought. */
async function loadPurchasablePlan(planSlug, kind) {
  const plan = await Plan.findOne({ slug: planSlug, kind, isActive: true });

  if (!plan) {
    throw new ApiError(404, 'That plan is not available.');
  }

  if (plan.pricePaise <= 0) {
    // A zero price would create a zero-amount order, which Razorpay rejects with a
    // message the user cannot act on. Ours says what is actually wrong.
    throw new ApiError(409, 'That plan has no price set yet, so it cannot be bought.');
  }

  if (kind === PLAN_KINDS.SUBSCRIPTION && !plan.providerPlanId) {
    throw new ApiError(
      409,
      'That subscription is not connected to the payment provider yet. Set its providerPlanId first.',
    );
  }

  return plan;
}

// --- credit packs ----------------------------------------------------------

/**
 * Creates an order for a credit pack.
 *
 * The provider order is created before our row, because our row needs the
 * provider's id and that id is unique and required. If the second write fails the
 * result is an unpaid order in Razorpay that nothing here can grant - the webhook
 * would find no matching row and ignore it. That is logged with the id so it is
 * recoverable, and an unpaid Razorpay order expires on its own and costs nothing.
 */
export async function createPackOrder({ user, planSlug }) {
  const plan = await loadPurchasablePlan(planSlug, PLAN_KINDS.CREDIT_PACK);

  // Razorpay caps receipt at 40 characters. 37 here, and random rather than
  // derived from the user, so a receipt in someone else's dashboard says nothing
  // about who we are.
  const receipt = `rcpt_${randomUUID().replaceAll('-', '')}`;

  const providerOrder = await payments.createOrder({
    amountPaise: plan.pricePaise,
    currency: CURRENCY,
    receipt,
    // Reconciliation from their dashboard back to ours. An ObjectId and a slug -
    // nothing about the person.
    notes: { userId: user._id.toString(), planSlug: plan.slug },
  });

  let order;

  try {
    order = await PaymentOrder.create({
      userId: user._id,
      planSlug: plan.slug,
      // Snapshots. The pack's size and price will be recalibrated, and this order
      // has to stay auditable against the numbers that were in force when it was
      // made.
      credits: plan.credits,
      amountPaise: plan.pricePaise,
      currency: CURRENCY,
      provider: payments.providerName,
      providerOrderId: providerOrder.providerOrderId,
    });
  } catch (error) {
    logger.error('Created a provider order but could not record it', {
      providerOrderId: providerOrder.providerOrderId,
      userId: user.id,
      message: error.message,
    });
    throw error;
  }

  logger.info('Created a credit pack order', {
    userId: user.id,
    planSlug: plan.slug,
    amountPaise: plan.pricePaise,
    providerOrderId: order.providerOrderId,
  });

  return {
    order: order.toPublicJSON(),
    keyId: payments.publicKeyId,
    provider: payments.providerName,
    isMock: payments.isMock,
    // Shown on the Checkout dialog.
    name: plan.name,
    description: `${plan.credits.toLocaleString('en-IN')} credits`,
  };
}

/**
 * Records that the browser reported a successful payment.
 *
 * Verifies the signature, which proves the browser is not inventing a payment.
 * Grants nothing: see the note at the top of this file. The response tells the
 * client whether the webhook has landed yet, so the UI can say "credits are on
 * their way" rather than showing an unchanged balance with no explanation.
 */
export async function confirmPackPayment({ user, providerOrderId, paymentId, signature }) {
  const order = await PaymentOrder.findOne({ userId: user._id, providerOrderId });

  // Ownership is in the filter, and a miss is 404 rather than 403 - so this
  // endpoint cannot be used to find out which order ids exist.
  if (!order) throw new ApiError(404, 'That order does not exist.');

  if (!payments.verifyPaymentSignature({ orderId: providerOrderId, paymentId, signature })) {
    logger.warn('Rejected a payment confirmation with a bad signature', {
      userId: user.id,
      providerOrderId,
    });

    throw new ApiError(400, 'That payment could not be verified.');
  }

  // Only ever fills in a blank. The webhook is the authority on this field too,
  // and overwriting its value with a client-supplied one would be a way to point
  // an order at a different payment.
  if (!order.providerPaymentId) {
    order.providerPaymentId = paymentId;
    await order.save();
  }

  return {
    verified: true,
    // false until the webhook lands, which is normally a second or two.
    credited: order.status === ORDER_STATUS.PAID,
    order: order.toPublicJSON(),
  };
}

/**
 * Development only: builds the webhook Razorpay would have sent.
 *
 * Returns a signed envelope for the caller to POST to /api/webhooks/razorpay,
 * rather than granting anything itself. That is the point - the simulated payment
 * goes through the real signature check, the real replay guard and the real grant,
 * so what is exercised locally is the code that runs in production.
 *
 * Absent in razorpay mode: payments.signWebhook is undefined there, so this
 * answers 404 instead of being a live endpoint that mints credits.
 */
export async function simulatePackPayment({ user, providerOrderId }) {
  if (!payments.isMock || !payments.signWebhook) {
    throw new ApiError(404, 'Not found');
  }

  const order = await PaymentOrder.findOne({ userId: user._id, providerOrderId });
  if (!order) throw new ApiError(404, 'That order does not exist.');

  const { paymentId, signature } = payments.simulateCheckout({ orderId: providerOrderId });

  const event = {
    entity: 'event',
    event: 'payment.captured',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: providerOrderId,
          amount: order.amountPaise,
          currency: order.currency,
          status: 'captured',
          method: 'mock',
        },
      },
    },
  };

  const rawBody = JSON.stringify(event);

  return {
    // What the Checkout handler would have received.
    checkout: { razorpay_order_id: providerOrderId, razorpay_payment_id: paymentId, razorpay_signature: signature },
    // What Razorpay would have POSTed, and the header that authenticates it.
    webhook: { rawBody, signature: payments.signWebhook(rawBody), eventId: `mock_evt_${randomUUID()}` },
  };
}

// --- subscriptions ---------------------------------------------------------

export async function createSubscription({ user, planSlug }) {
  const plan = await loadPurchasablePlan(planSlug, PLAN_KINDS.SUBSCRIPTION);

  const existing = await Subscription.findOne({
    userId: user._id,
    status: { $in: LIVE_SUBSCRIPTION_STATUSES },
  });

  if (existing) {
    // One at a time. Two live subscriptions would grant two allowances a month and
    // leave planSlug ambiguous, and no user means to buy that.
    throw new ApiError(409, 'This account already has a subscription. Cancel it first.');
  }

  const providerSubscription = await payments.createSubscription({
    providerPlanId: plan.providerPlanId,
    totalCount: SUBSCRIPTION_TOTAL_COUNT,
    notes: { userId: user._id.toString(), planSlug: plan.slug },
  });

  const subscription = await Subscription.create({
    userId: user._id,
    planSlug: plan.slug,
    creditsPerCycle: plan.credits,
    amountPaise: plan.pricePaise,
    currency: CURRENCY,
    provider: payments.providerName,
    providerSubscriptionId: providerSubscription.providerSubscriptionId,
    providerPlanId: providerSubscription.providerPlanId ?? plan.providerPlanId,
    status: providerSubscription.status,
    currentStart: providerSubscription.currentStart,
    currentEnd: providerSubscription.currentEnd,
    chargeAt: providerSubscription.chargeAt,
  });

  logger.info('Created a subscription', {
    userId: user.id,
    planSlug: plan.slug,
    providerSubscriptionId: subscription.providerSubscriptionId,
  });

  return {
    subscription: subscription.toPublicJSON(),
    keyId: payments.publicKeyId,
    provider: payments.providerName,
    isMock: payments.isMock,
    // Razorpay's hosted authorisation page. Checkout can also be opened in-page
    // with subscription_id; the short url is the fallback that always works.
    shortUrl: providerSubscription.shortUrl,
    name: plan.name,
    description: `${plan.credits.toLocaleString('en-IN')} credits per cycle`,
  };
}

/** Verifies the signature Checkout returns after the mandate is authorised. */
export async function confirmSubscription({ user, providerSubscriptionId, paymentId, signature }) {
  const subscription = await Subscription.findOne({ userId: user._id, providerSubscriptionId });

  if (!subscription) throw new ApiError(404, 'That subscription does not exist.');

  if (
    !payments.verifySubscriptionSignature({ paymentId, subscriptionId: providerSubscriptionId, signature })
  ) {
    logger.warn('Rejected a subscription confirmation with a bad signature', {
      userId: user.id,
      providerSubscriptionId,
    });

    throw new ApiError(400, 'That subscription could not be verified.');
  }

  // Status still comes from the webhook. Nothing here promotes it to active: the
  // browser saying the mandate was authorised is not the same fact as the provider
  // having charged it.
  return { verified: true, subscription: subscription.toPublicJSON() };
}

/**
 * Cancels, at the end of the paid-for cycle by default.
 *
 * The final status change comes from the subscription.cancelled webhook, so this
 * records the intent (cancelAtCycleEnd) and lets the provider be the authority on
 * when it takes effect.
 */
export async function cancelSubscription({ user, providerSubscriptionId, atCycleEnd = true }) {
  const subscription = await Subscription.findOne({ userId: user._id, providerSubscriptionId });

  if (!subscription) throw new ApiError(404, 'That subscription does not exist.');

  if (!LIVE_SUBSCRIPTION_STATUSES.includes(subscription.status)) {
    throw new ApiError(409, `This subscription is already ${subscription.status}.`);
  }

  const updated = await payments.cancelSubscription(providerSubscriptionId, { atCycleEnd });

  subscription.cancelAtCycleEnd = atCycleEnd;
  subscription.status = updated.status;
  if (updated.endedAt) subscription.endedAt = updated.endedAt;
  await subscription.save();

  logger.info('Cancelled a subscription', {
    userId: user.id,
    providerSubscriptionId,
    atCycleEnd,
    status: subscription.status,
  });

  return subscription.toPublicJSON();
}

/**
 * Resumes a paused subscription.
 *
 * Razorpay has no un-cancel - `cancelled` is terminal and a new subscription is
 * the only way back - so this refuses anything that is not paused rather than
 * calling the provider and surfacing its error.
 */
export async function resumeSubscription({ user, providerSubscriptionId }) {
  const subscription = await Subscription.findOne({ userId: user._id, providerSubscriptionId });

  if (!subscription) throw new ApiError(404, 'That subscription does not exist.');

  if (subscription.status !== SUBSCRIPTION_STATUS.PAUSED) {
    throw new ApiError(
      409,
      subscription.status === SUBSCRIPTION_STATUS.CANCELLED
        ? 'A cancelled subscription cannot be resumed. Subscribe again to restart it.'
        : `Only a paused subscription can be resumed; this one is ${subscription.status}.`,
    );
  }

  const updated = await payments.resumeSubscription(providerSubscriptionId);

  subscription.status = updated.status;
  subscription.cancelAtCycleEnd = false;
  await subscription.save();

  logger.info('Resumed a subscription', { userId: user.id, providerSubscriptionId });

  return subscription.toPublicJSON();
}

// --- history ---------------------------------------------------------------

export async function listPayments({ userId, limit = MAX_HISTORY }) {
  const orders = await PaymentOrder.find({ userId })
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(limit, 1), MAX_HISTORY));

  return orders.map((order) => order.toPublicJSON());
}

export async function listSubscriptions({ userId }) {
  const subscriptions = await Subscription.find({ userId }).sort({ createdAt: -1 }).limit(MAX_HISTORY);

  return subscriptions.map((subscription) => subscription.toPublicJSON());
}

// --- webhooks --------------------------------------------------------------

/**
 * The one entry point for a provider webhook.
 *
 * Order of operations, and every step is load-bearing:
 *
 *   1. Verify the signature over the RAW bytes. Before this, the body is an
 *      unauthenticated stranger's JSON.
 *   2. Claim the event by its provider event id. A duplicate delivery loses the
 *      claim and returns immediately.
 *   3. Handle it.
 *   4. Mark the claim processed - or failed, so the provider's next retry can
 *      reclaim it rather than being told it is already done.
 *
 * Returns { status, httpStatus }. A 2xx stops the provider retrying, so anything
 * we could not handle but should not be sent again (an unknown event, an order
 * from a different environment sharing these keys) returns 200 with `ignored`.
 */
export async function handleWebhook({ rawBody, signature, eventId }) {
  if (!signature) {
    throw new ApiError(400, 'Missing webhook signature');
  }

  if (!payments.verifyWebhookSignature({ rawBody, signature })) {
    // Warn rather than error: an unauthenticated POST to a public URL is expected
    // background noise on the internet, not a fault in this service. It is logged
    // because a sudden run of these is worth seeing.
    logger.warn('Rejected a webhook with an invalid signature');
    throw new ApiError(400, 'Invalid webhook signature');
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new ApiError(400, 'Webhook body is not valid JSON');
  }

  const eventName = typeof body?.event === 'string' ? body.event : null;

  if (!eventName) {
    throw new ApiError(400, 'Webhook body has no event name');
  }

  /**
   * The provider's own id for this delivery, or a hash of the exact bytes.
   *
   * The header is what Razorpay sends and is stable across retries of one event.
   * The fallback keeps the guard working if it is ever absent: identical bytes
   * hash identically, so a byte-for-byte replay still collides. Two genuinely
   * different events never produce the same hash.
   */
  const providerEventId =
    eventId || `sha256:${createHash('sha256').update(rawBody).digest('hex')}`;

  const subjectId =
    body?.payload?.subscription?.entity?.id ??
    body?.payload?.payment?.entity?.order_id ??
    body?.payload?.order?.entity?.id ??
    null;

  const claim = await claimEvent({ providerEventId, eventName, subjectId });

  if (!claim.claimed) {
    return { status: claim.status, httpStatus: claim.httpStatus, duplicate: true };
  }

  try {
    const outcome = await dispatchEvent(eventName, body);

    await WebhookEvent.updateOne(
      { _id: claim.row._id },
      {
        $set: {
          status: outcome.handled ? WEBHOOK_STATUS.PROCESSED : WEBHOOK_STATUS.IGNORED,
          processedAt: new Date(),
          error: '',
        },
      },
    );

    return { status: outcome.handled ? 'processed' : 'ignored', httpStatus: 200, note: outcome.note };
  } catch (error) {
    await WebhookEvent.updateOne(
      { _id: claim.row._id },
      { $set: { status: WEBHOOK_STATUS.FAILED, error: error.message.slice(0, 500) } },
    );

    logger.error('Webhook handler failed', { event: eventName, providerEventId, message: error.message });

    // Rethrown so the endpoint answers 5xx and the provider retries. The claim is
    // now `failed`, which is what lets that retry get through.
    throw error;
  }
}

/**
 * Takes exclusive ownership of one event, or explains why it could not.
 *
 * The insert is the claim: a unique index on providerEventId means the second
 * concurrent delivery gets a duplicate key error rather than a second handler run.
 */
async function claimEvent({ providerEventId, eventName, subjectId }) {
  try {
    const row = await WebhookEvent.create({
      provider: payments.providerName,
      providerEventId,
      event: eventName,
      subjectId,
      status: WEBHOOK_STATUS.PROCESSING,
    });

    return { claimed: true, row };
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }

  const existing = await WebhookEvent.findOne({ providerEventId });

  if (!existing) {
    // The row was deleted between the failed insert and this read. Vanishingly
    // unlikely, and a retry is the right answer rather than a guess.
    return { claimed: false, status: 'retry', httpStatus: 409 };
  }

  await WebhookEvent.updateOne({ _id: existing._id }, { $inc: { attempts: 1 } });

  if (existing.status === WEBHOOK_STATUS.PROCESSED || existing.status === WEBHOOK_STATUS.IGNORED) {
    logger.info('Ignored a duplicate webhook delivery', {
      event: eventName,
      providerEventId,
      firstStatus: existing.status,
    });

    // 200: it is done, and the provider should stop retrying.
    return { claimed: false, status: 'duplicate', httpStatus: 200 };
  }

  /**
   * `failed`, or `processing` from a handler that died. Both are reclaimable, and
   * the compare-and-set on status is what stops two retries reclaiming at once.
   *
   * A live `processing` row younger than the grace window is a genuinely
   * concurrent delivery: 409 tells the provider to come back, and by then the
   * first will have finished and this becomes the duplicate case above.
   */
  const isStale = Date.now() - existing.updatedAt.getTime() > PROCESSING_GRACE_MS;

  if (existing.status === WEBHOOK_STATUS.PROCESSING && !isStale) {
    return { claimed: false, status: 'in-flight', httpStatus: 409 };
  }

  const reclaimed = await WebhookEvent.findOneAndUpdate(
    { _id: existing._id, status: existing.status },
    { $set: { status: WEBHOOK_STATUS.PROCESSING } },
    { returnDocument: 'after' },
  );

  if (!reclaimed) {
    return { claimed: false, status: 'in-flight', httpStatus: 409 };
  }

  logger.warn('Reprocessing a webhook that did not complete', {
    event: eventName,
    providerEventId,
    previousStatus: existing.status,
  });

  return { claimed: true, row: reclaimed };
}

/**
 * Routes one event to its handler.
 *
 * Returns { handled } - false means "recognised as something we deliberately do
 * nothing about", which is recorded as `ignored` and answered with a 200 so the
 * provider stops resending it.
 */
async function dispatchEvent(eventName, body) {
  switch (eventName) {
    // Both of these mean the same money arrived. Razorpay sends both, and handling
    // both is safe: they claim separately here but share one ledger idempotencyKey,
    // so whichever is second grants nothing.
    case 'payment.captured':
    case 'order.paid':
      return grantPackCredits(body);

    case 'payment.failed':
      return recordPackFailure(body);

    case 'subscription.charged':
      return grantSubscriptionCycle(body);

    case 'subscription.authenticated':
      return syncSubscriptionStatus(body, SUBSCRIPTION_STATUS.AUTHENTICATED);
    case 'subscription.activated':
    case 'subscription.resumed':
      return syncSubscriptionStatus(body, SUBSCRIPTION_STATUS.ACTIVE);
    case 'subscription.pending':
      return syncSubscriptionStatus(body, SUBSCRIPTION_STATUS.PENDING);
    case 'subscription.halted':
      return syncSubscriptionStatus(body, SUBSCRIPTION_STATUS.HALTED);
    case 'subscription.paused':
      return syncSubscriptionStatus(body, SUBSCRIPTION_STATUS.PAUSED);
    case 'subscription.cancelled':
      return syncSubscriptionStatus(body, SUBSCRIPTION_STATUS.CANCELLED);
    case 'subscription.completed':
      return syncSubscriptionStatus(body, SUBSCRIPTION_STATUS.COMPLETED);

    default:
      logger.info('Received a webhook event with no handler', { event: eventName });
      return { handled: false, note: `no handler for ${eventName}` };
  }
}

/**
 * The one place purchased credits come into existence.
 *
 * The claim is PaymentOrder.creditedAt: a single-document compare-and-set, so two
 * deliveries racing here cannot both win. grantCredits then refuses a second write
 * on the ledger's unique key regardless, which is the second layer.
 *
 * The amount granted is the snapshot on our order row, never the amount in the
 * webhook body. The body is authenticated, not authoritative: it says what was
 * paid, and what a pack is worth is our decision, recorded when the order was made.
 */
async function grantPackCredits(body) {
  const payment = body?.payload?.payment?.entity ?? null;
  const order = body?.payload?.order?.entity ?? null;

  const providerOrderId = payment?.order_id ?? order?.id ?? null;
  const providerPaymentId = payment?.id ?? null;

  if (!providerOrderId) {
    return { handled: false, note: 'event carried no order id' };
  }

  const claimed = await PaymentOrder.findOneAndUpdate(
    { providerOrderId, creditedAt: null },
    {
      $set: {
        status: ORDER_STATUS.PAID,
        creditedAt: new Date(),
        ...(providerPaymentId ? { providerPaymentId } : {}),
      },
    },
    { returnDocument: 'after' },
  );

  if (!claimed) {
    const known = await PaymentOrder.findOne({ providerOrderId }).lean();

    if (!known) {
      // An order this deployment did not create. Normal when one Razorpay test
      // account is shared between a laptop and a staging deployment - each gets the
      // other's webhooks. 200, so it stops being resent.
      logger.warn('Webhook referenced an unknown order', { providerOrderId });
      return { handled: false, note: 'unknown order' };
    }

    logger.info('Order was already credited', { providerOrderId });
    return { handled: false, note: 'already credited' };
  }

  const result = await grantCredits({
    userId: claimed.userId,
    credits: claimed.credits,
    // Bought outright, so they never expire. This is the bucket reserve() drains
    // second, after subscription credits.
    bucket: BUCKETS.PURCHASED,
    type: LEDGER_TYPES.PURCHASE,
    // One grant per order, forever. Derived from the order rather than the event,
    // so payment.captured and order.paid produce the same key.
    idempotencyKey: `purchase:${providerOrderId}`,
    note: `Credit pack: ${claimed.planSlug}`,
  });

  logger.info('Credited a paid order', {
    providerOrderId,
    userId: claimed.userId.toString(),
    credits: claimed.credits,
    granted: result.granted,
  });

  return { handled: true, note: `granted ${result.credits} credits` };
}

async function recordPackFailure(body) {
  const payment = body?.payload?.payment?.entity ?? null;
  const providerOrderId = payment?.order_id ?? null;

  if (!providerOrderId) return { handled: false, note: 'event carried no order id' };

  // Only a still-created order. A paid order that later reports a failed payment
  // attempt (a retry after a success) must not be walked backwards.
  const updated = await PaymentOrder.updateOne(
    { providerOrderId, status: ORDER_STATUS.CREATED },
    {
      $set: {
        status: ORDER_STATUS.FAILED,
        failureReason: (payment?.error_description ?? 'The payment did not go through.').slice(0, 300),
      },
    },
  );

  return { handled: updated.modifiedCount > 0, note: 'recorded a failed payment' };
}

/**
 * A subscription cycle was charged: sync the row and grant that cycle's credits.
 *
 * RENEWAL POLICY IS DELIBERATELY NOT IMPLEMENTED HERE.
 *
 * DECISIONS.md §2 has reset / rollover / partial rollover as an open question, and
 * Plan.creditRenewalPolicy exists to hold the answer. Until it is chosen this
 * grant is purely ADDITIVE: it adds the cycle's allowance and takes nothing away.
 *
 * That is not a decision in disguise, it is the only reversible option. Adding an
 * expiry step later is additive work - an EXPIRY ledger row written before the
 * grant, which the enum already has a value for. Credits wrongly reset in the
 * meantime cannot be given back, because we would not know how many there were.
 */
async function grantSubscriptionCycle(body) {
  const entity = body?.payload?.subscription?.entity ?? null;
  const payment = body?.payload?.payment?.entity ?? null;

  const providerSubscriptionId = entity?.id ?? null;

  if (!providerSubscriptionId) {
    return { handled: false, note: 'event carried no subscription id' };
  }

  const subscription = await Subscription.findOne({ providerSubscriptionId });

  if (!subscription) {
    logger.warn('Webhook referenced an unknown subscription', { providerSubscriptionId });
    return { handled: false, note: 'unknown subscription' };
  }

  applyProviderState(subscription, entity, SUBSCRIPTION_STATUS.ACTIVE);
  subscription.lastChargedAt = new Date();
  subscription.cyclesPaid = entity?.paid_count ?? subscription.cyclesPaid + 1;
  await subscription.save();

  if (subscription.creditsPerCycle <= 0) {
    return { handled: true, note: 'subscription grants no credits' };
  }

  /**
   * One key per charge, not per subscription.
   *
   * The payment id is what makes each cycle distinct - a per-subscription key would
   * grant the first month and silently skip every month after it. When the payment
   * id is missing the cycle start stands in, which is also distinct per cycle.
   */
  const cycleKey =
    payment?.id ?? (entity?.current_start ? `cycle-${entity.current_start}` : `count-${subscription.cyclesPaid}`);

  const result = await grantCredits({
    userId: subscription.userId,
    credits: subscription.creditsPerCycle,
    // The bucket that may expire, which is where a renewal policy would eventually
    // act. Purchased credits never expire and must not be used here.
    bucket: BUCKETS.SUBSCRIPTION,
    // The ledger has no dedicated renewal type, and adding one is a change to a
    // completed module. PURCHASE is accurate - this cycle was bought - and the key
    // prefix is what distinguishes it from a one-off pack.
    type: LEDGER_TYPES.PURCHASE,
    idempotencyKey: `sub-charge:${providerSubscriptionId}:${cycleKey}`,
    note: `Subscription cycle: ${subscription.planSlug}`,
  });

  logger.info('Credited a subscription cycle', {
    providerSubscriptionId,
    userId: subscription.userId.toString(),
    credits: subscription.creditsPerCycle,
    granted: result.granted,
  });

  return { handled: true, note: `granted ${result.credits} credits` };
}

async function syncSubscriptionStatus(body, status) {
  const entity = body?.payload?.subscription?.entity ?? null;
  const providerSubscriptionId = entity?.id ?? null;

  if (!providerSubscriptionId) {
    return { handled: false, note: 'event carried no subscription id' };
  }

  const subscription = await Subscription.findOne({ providerSubscriptionId });

  if (!subscription) {
    logger.warn('Webhook referenced an unknown subscription', { providerSubscriptionId });
    return { handled: false, note: 'unknown subscription' };
  }

  applyProviderState(subscription, entity, status);

  if (status === SUBSCRIPTION_STATUS.CANCELLED || status === SUBSCRIPTION_STATUS.COMPLETED) {
    subscription.endedAt = subscription.endedAt ?? new Date();
  }

  if (status === SUBSCRIPTION_STATUS.ACTIVE) {
    // A resume or a re-activation clears a pending cancellation, which is the
    // whole point of resuming.
    subscription.cancelAtCycleEnd = false;
  }

  await subscription.save();

  logger.info('Subscription status changed', { providerSubscriptionId, status });

  return { handled: true, note: `status ${status}` };
}

/** Copies the provider's period fields onto our row, ignoring anything absent. */
function applyProviderState(subscription, entity, status) {
  const toDate = (seconds) => (seconds ? new Date(seconds * 1_000) : null);

  subscription.status = status;

  const currentStart = toDate(entity?.current_start);
  const currentEnd = toDate(entity?.current_end);
  const chargeAt = toDate(entity?.charge_at);
  const endedAt = toDate(entity?.ended_at);

  if (currentStart) subscription.currentStart = currentStart;
  if (currentEnd) subscription.currentEnd = currentEnd;
  if (chargeAt) subscription.chargeAt = chargeAt;
  if (endedAt) subscription.endedAt = endedAt;
}
