import { CreditTransaction } from '../credits/creditTransaction.model.js';
import { Generation } from '../generations/generation.model.js';
import { Plan } from '../plans/plan.model.js';
import { User } from '../users/user.model.js';
import { Voice } from '../voices/voice.model.js';

import { ORDER_STATUS, PaymentOrder } from '../billing/paymentOrder.model.js';
import { LIVE_SUBSCRIPTION_STATUSES, Subscription } from '../billing/subscription.model.js';
import { WebhookEvent } from '../billing/webhookEvent.model.js';

/**
 * A read-only window onto the data, for an operator.
 *
 * Deliberately small: four queries, no writes, no charts, no editing. Everything
 * an operator needs to change - a plan's price, a voice's cost multiplier, who is
 * an admin - is changed in the database or by re-seeding, which is auditable and
 * cannot be reached by a stolen session.
 *
 * There is therefore no admin endpoint anywhere that grants credits, refunds a
 * payment, or writes User.role. The credit ledger stays a record of things that
 * actually happened rather than things an operator typed.
 */

const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

function clampPaging({ page = 1, limit = DEFAULT_PAGE_SIZE }) {
  const safeLimit = Math.min(Math.max(limit, 1), MAX_PAGE_SIZE);
  const safePage = Math.max(page, 1);

  return { limit: safeLimit, page: safePage, skip: (safePage - 1) * safeLimit };
}

/** Turns [{_id: 'done', count: 3}] into {done: 3} for a stable response shape. */
function tally(rows) {
  return Object.fromEntries(rows.map((row) => [row._id ?? 'unknown', row.count]));
}

/**
 * Users, newest first, with an optional email search.
 *
 * The search term is escaped before it becomes a regex. An unescaped one lets a
 * caller send `.*` (harmless) or a nested-quantifier pattern (not harmless - it
 * pins a CPU), and this endpoint is reachable by anyone who is an admin.
 */
export async function listUsers({ search = '', page, limit } = {}) {
  const paging = clampPaging({ page, limit });

  const filter = search
    ? { email: new RegExp(search.trim().replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
    : {};

  const [users, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(paging.skip).limit(paging.limit),
    User.countDocuments(filter),
  ]);

  return {
    users: users.map((user) => ({
      ...user.toPublicJSON(),
      // Operational fields toPublicJSON does not carry, because a normal client has
      // no use for them.
      role: user.role,
      signupCreditsGrantedAt: user.signupCreditsGrantedAt,
    })),
    pagination: {
      page: paging.page,
      limit: paging.limit,
      total,
      totalPages: Math.max(Math.ceil(total / paging.limit), 1),
    },
  };
}

/**
 * Every plan, including inactive ones.
 *
 * The public /api/plans endpoint filters to active plans and hides the fields
 * below. An operator needs exactly those fields - a subscription with no
 * providerPlanId is the single most common reason a subscribe button 409s.
 */
export async function listPlans() {
  const plans = await Plan.find({}).sort({ kind: 1, pricePaise: 1 });

  return plans.map((plan) => ({
    ...plan.toPublicJSON(),
    isActive: plan.isActive,
    providerPlanId: plan.providerPlanId,
    creditRenewalPolicy: plan.creditRenewalPolicy,
    // Still an open question in DECISIONS.md §4; null means undecided, not false.
    gstIncluded: plan.gstIncluded,
  }));
}

/** The voice catalog, including retired voices, so a missing voice is explainable. */
export async function listVoices({ page, limit } = {}) {
  const paging = clampPaging({ page, limit });

  const [voices, total] = await Promise.all([
    Voice.find({})
      .sort({ isActive: -1, languageCode: 1, providerVoiceId: 1 })
      .skip(paging.skip)
      .limit(paging.limit),
    Voice.countDocuments({}),
  ]);

  return {
    voices: voices.map((voice) => ({
      ...voice.toPublicJSON(),
      provider: voice.provider,
      isActive: voice.isActive,
    })),
    pagination: {
      page: paging.page,
      limit: paging.limit,
      total,
      totalPages: Math.max(Math.ceil(total / paging.limit), 1),
    },
  };
}

/**
 * The overview: counts, not records.
 *
 * All of it in one round of parallel aggregations, and every number is derived
 * rather than stored - so nothing here can disagree with the collections it is
 * counting. Revenue sums only orders that reached `paid`, which is the only status
 * that means money actually arrived.
 */
export async function getOverview() {
  const [
    users,
    verifiedUsers,
    generationsByStatus,
    creditsByType,
    ordersByStatus,
    revenue,
    liveSubscriptions,
    subscriptionsByStatus,
    recentWebhooks,
    ungrantedPaidOrders,
  ] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ emailVerifiedAt: { $ne: null } }),

    Generation.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),

    // Signed sums, so charges come out negative. A per-type breakdown is what makes
    // "where did the credits go" answerable at a glance.
    CreditTransaction.aggregate([
      { $group: { _id: '$type', credits: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),

    PaymentOrder.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),

    PaymentOrder.aggregate([
      { $match: { status: ORDER_STATUS.PAID } },
      { $group: { _id: null, amountPaise: { $sum: '$amountPaise' }, credits: { $sum: '$credits' } } },
    ]),

    Subscription.countDocuments({ status: { $in: LIVE_SUBSCRIPTION_STATUSES } }),
    Subscription.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),

    WebhookEvent.find({}).sort({ createdAt: -1 }).limit(20),

    /**
     * The one number worth alerting on.
     *
     * A paid order with no creditedAt means the money arrived and the credits did
     * not - a webhook that never landed, or a handler that failed every retry.
     * Nothing else on this page describes a user who is actually out of pocket.
     */
    PaymentOrder.countDocuments({ status: ORDER_STATUS.PAID, creditedAt: null }),
  ]);

  return {
    users: { total: users, verified: verifiedUsers, unverified: users - verifiedUsers },
    generations: {
      total: generationsByStatus.reduce((sum, row) => sum + row.count, 0),
      byStatus: tally(generationsByStatus),
    },
    credits: {
      byType: Object.fromEntries(
        creditsByType.map((row) => [row._id, { credits: row.credits, entries: row.count }]),
      ),
    },
    payments: {
      byStatus: tally(ordersByStatus),
      // Integer paise everywhere. The client divides by 100 for display; nothing
      // server-side ever holds money in a float.
      revenuePaise: revenue[0]?.amountPaise ?? 0,
      creditsSold: revenue[0]?.credits ?? 0,
      paidButUncredited: ungrantedPaidOrders,
    },
    subscriptions: { live: liveSubscriptions, byStatus: tally(subscriptionsByStatus) },
    webhooks: recentWebhooks.map((event) => event.toPublicJSON()),
  };
}
