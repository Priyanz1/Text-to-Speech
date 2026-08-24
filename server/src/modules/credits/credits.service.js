import mongoose from 'mongoose';

import { logger } from '../../config/logger.js';
import { ApiError } from '../../utils/ApiError.js';
import { Generation } from '../generations/generation.model.js';
import { getFreePlan } from '../plans/plans.service.js';
import { User } from '../users/user.model.js';

import { BUCKETS, CreditTransaction, LEDGER_TYPES } from './creditTransaction.model.js';

/**
 * Every credit movement in the application goes through this file.
 *
 * Two rules hold everywhere below:
 *
 *   1. A balance change is one atomic operation on one document. MongoDB
 *      guarantees single-document atomicity, so a conditional update that both
 *      checks the balance and spends it cannot be raced - which a
 *      read-then-write can, and the way it loses is by letting two concurrent
 *      generations spend the same last credit.
 *
 *   2. Every ledger row carries a deterministic idempotencyKey. A retry, a
 *      double-clicked button, or a duplicate webhook delivery collides on the
 *      unique index instead of moving credits twice. Error 11000 means "already
 *      done", which is a success.
 */

/**
 * Appends a ledger row, treating a duplicate key as already-written.
 *
 * Returns null when the row already existed, so callers can tell "I did this"
 * from "someone already did".
 */
async function appendRow(row) {
  try {
    return await CreditTransaction.create(row);
  } catch (error) {
    if (error?.code === 11000) return null;
    throw error;
  }
}

/**
 * Hands a newly verified account its free credits. Safe to call repeatedly.
 *
 * IMPORTANT: this function does not check that the email is verified - it cannot,
 * because it is called at the moment verification is being recorded. Callers must
 * only call it once they have proven the verification, and must call it BEFORE
 * setting emailVerifiedAt: resendVerification returns early for an
 * already-verified address, so a grant that failed after the flag was set would
 * leave someone verified, ungranted, and with no way to ask again.
 *
 * Returns the granted amount, or 0 if this account was already granted.
 */
export async function grantSignupCredits(user) {
  const plan = await getFreePlan();

  if (!plan || plan.credits <= 0) {
    logger.warn('No active free plan with credits; skipping signup grant', { userId: user.id });
    return 0;
  }

  // Claiming signupCreditsGrantedAt and incrementing the balance in one update is
  // what makes this idempotent: the second caller matches nothing.
  const granted = await User.findOneAndUpdate(
    { _id: user._id, signupCreditsGrantedAt: null },
    {
      $set: { signupCreditsGrantedAt: new Date(), planSlug: plan.slug },
      $inc: { subscriptionCredits: plan.credits },
    },
    { returnDocument: 'after' },
  );

  if (!granted) return 0;

  await appendRow({
    userId: user._id,
    type: LEDGER_TYPES.SIGNUP_GRANT,
    // The bucket that may expire and is spent first. The free grant is not a
    // purchase, and DECISIONS.md §2 has not settled whether these expire - this
    // is the bucket where either answer still works.
    bucket: BUCKETS.SUBSCRIPTION,
    amount: plan.credits,
    balanceAfter: granted.subscriptionCredits,
    idempotencyKey: `signup-grant:${user._id.toString()}`,
    note: `Free credits on verifying email (plan: ${plan.slug})`,
  });

  logger.info('Granted signup credits', { userId: user.id, credits: plan.credits });

  return plan.credits;
}

/**
 * Spends credits, or fails without spending any.
 *
 * The whole operation is one update:
 *
 *   - the filter carries the balance check ($expr over the sum of both buckets),
 *     so a user who cannot afford it matches nothing and nothing moves;
 *   - the pipeline stage drains subscription credits first, then purchased. Every
 *     expression in a single $set sees the document as it was before the stage,
 *     so both new values are computed from the same pre-update balances.
 *
 * Because it is one document and one operation, two concurrent requests for the
 * last 30 credits cannot both succeed. No transaction, no lock, no retry loop.
 *
 * Returns { credits, split: { subscription, purchased }, balanceAfter }.
 * Throws 402 when the balance is short.
 */
export async function reserve({ userId, credits, generationId = null, note = '' }) {
  if (!Number.isInteger(credits) || credits < 1) {
    throw new ApiError(500, 'Refusing to reserve a non-positive or fractional number of credits');
  }

  const before = await User.findOneAndUpdate(
    {
      _id: userId,
      $expr: { $gte: [{ $add: ['$subscriptionCredits', '$purchasedCredits'] }, credits] },
    },
    [
      {
        $set: {
          subscriptionCredits: { $max: [0, { $subtract: ['$subscriptionCredits', credits] }] },
          purchasedCredits: {
            $subtract: [
              '$purchasedCredits',
              // Only the part subscription credits could not cover.
              { $max: [0, { $subtract: [credits, '$subscriptionCredits'] }] },
            ],
          },
        },
      },
    ],
    // 'before' so the split can be recomputed from the balances the update
    // actually acted on, rather than inferred from the result.
    { returnDocument: 'before' },
  );

  if (!before) {
    // The caller is authenticated, so a miss here is a short balance rather than
    // a missing user. 402 Payment Required is the accurate status.
    const current = await User.findById(userId).select('subscriptionCredits purchasedCredits').lean();
    const available = (current?.subscriptionCredits ?? 0) + (current?.purchasedCredits ?? 0);

    throw new ApiError(402, `Not enough credits: this needs ${credits} and you have ${available}.`, {
      required: credits,
      available,
    });
  }

  const fromSubscription = Math.min(before.subscriptionCredits, credits);
  const fromPurchased = credits - fromSubscription;

  const balanceAfter = {
    subscription: before.subscriptionCredits - fromSubscription,
    purchased: before.purchasedCredits - fromPurchased,
  };

  // One row per bucket that moved, so no row is ambiguous about which balance it
  // describes.
  if (fromSubscription > 0) {
    await appendRow({
      userId,
      type: LEDGER_TYPES.GENERATION_CHARGE,
      bucket: BUCKETS.SUBSCRIPTION,
      amount: -fromSubscription,
      balanceAfter: balanceAfter.subscription,
      idempotencyKey: `charge:${generationId}:${BUCKETS.SUBSCRIPTION}`,
      generationId,
      note,
    });
  }

  if (fromPurchased > 0) {
    await appendRow({
      userId,
      type: LEDGER_TYPES.GENERATION_CHARGE,
      bucket: BUCKETS.PURCHASED,
      amount: -fromPurchased,
      balanceAfter: balanceAfter.purchased,
      idempotencyKey: `charge:${generationId}:${BUCKETS.PURCHASED}`,
      generationId,
      note,
    });
  }

  return {
    credits,
    split: { subscription: fromSubscription, purchased: fromPurchased },
    balanceAfter: { ...balanceAfter, total: balanceAfter.subscription + balanceAfter.purchased },
  };
}

/**
 * Puts a failed generation's credits back, into the buckets they came out of.
 *
 * Refunding by the recorded split rather than into one bucket matters: paying a
 * subscription charge back as purchased credits would quietly convert credits
 * that may expire into credits that never do.
 *
 * The refund is claimed on the Generation first (a single-document compare-and-
 * set on creditsRefunded), so a retried failure path cannot refund twice. If the
 * balance update then fails the claim is released, leaving the refund retryable.
 *
 * Returns the refunded amount, or 0 if it was already refunded.
 */
export async function refund({ generation, note = '' }) {
  const fromSubscription = generation.creditSplit?.subscription ?? 0;
  const fromPurchased = generation.creditSplit?.purchased ?? 0;
  const total = fromSubscription + fromPurchased;

  if (total <= 0) return 0;

  const claimed = await Generation.findOneAndUpdate(
    { _id: generation._id, creditsRefunded: 0 },
    { $set: { creditsRefunded: total } },
    { returnDocument: 'after' },
  );

  if (!claimed) return 0;

  let restored;

  try {
    restored = await User.findByIdAndUpdate(
      generation.userId,
      { $inc: { subscriptionCredits: fromSubscription, purchasedCredits: fromPurchased } },
      { returnDocument: 'after' },
    );
  } catch (error) {
    // Release the claim so the next attempt can refund. Without this a transient
    // write error would permanently strand the user's credits.
    await Generation.updateOne({ _id: generation._id }, { $set: { creditsRefunded: 0 } });
    throw error;
  }

  if (fromSubscription > 0) {
    await appendRow({
      userId: generation.userId,
      type: LEDGER_TYPES.GENERATION_REFUND,
      bucket: BUCKETS.SUBSCRIPTION,
      amount: fromSubscription,
      balanceAfter: restored.subscriptionCredits,
      idempotencyKey: `refund:${generation._id.toString()}:${BUCKETS.SUBSCRIPTION}`,
      generationId: generation._id,
      note,
    });
  }

  if (fromPurchased > 0) {
    await appendRow({
      userId: generation.userId,
      type: LEDGER_TYPES.GENERATION_REFUND,
      bucket: BUCKETS.PURCHASED,
      amount: fromPurchased,
      balanceAfter: restored.purchasedCredits,
      idempotencyKey: `refund:${generation._id.toString()}:${BUCKETS.PURCHASED}`,
      generationId: generation._id,
      note,
    });
  }

  logger.info('Refunded credits for a failed generation', {
    generationId: generation._id.toString(),
    credits: total,
  });

  return total;
}

export async function getBalance(userId) {
  const user = await User.findById(userId)
    .select('subscriptionCredits purchasedCredits planSlug')
    .lean();

  if (!user) throw new ApiError(404, 'User not found');

  return {
    subscription: user.subscriptionCredits,
    purchased: user.purchasedCredits,
    total: user.subscriptionCredits + user.purchasedCredits,
    planSlug: user.planSlug,
  };
}

/** One user's ledger, newest first. Backed by the { userId, createdAt } index. */
export async function listLedger({ userId, limit = 50 }) {
  const rows = await CreditTransaction.find({ userId })
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(limit, 1), 200));

  return rows.map((row) => row.toPublicJSON());
}

/**
 * Checks the cached balances against the ledger they are a cache of.
 *
 * The invariant is SUM(amount) per bucket === the matching balance on User.
 * Nothing calls this in a request path; it exists so "the numbers look wrong" is
 * a question with an answer, and it is what would catch a crash between a refund
 * claim and its balance update.
 */
export async function reconcile(userId) {
  // aggregate() bypasses Mongoose casting, so the id has to be a real ObjectId
  // here - a string would match nothing and report every balance as drifted.
  const objectId = new mongoose.Types.ObjectId(String(userId));

  const [sums, user] = await Promise.all([
    CreditTransaction.aggregate([
      { $match: { userId: objectId } },
      { $group: { _id: '$bucket', total: { $sum: '$amount' } } },
    ]),
    User.findById(userId).select('subscriptionCredits purchasedCredits').lean(),
  ]);

  if (!user) throw new ApiError(404, 'User not found');

  const ledger = Object.fromEntries(sums.map((row) => [row._id, row.total]));

  const result = {
    subscription: { ledger: ledger.subscription ?? 0, cached: user.subscriptionCredits },
    purchased: { ledger: ledger.purchased ?? 0, cached: user.purchasedCredits },
  };

  result.ok =
    result.subscription.ledger === result.subscription.cached &&
    result.purchased.ledger === result.purchased.cached;

  return result;
}
