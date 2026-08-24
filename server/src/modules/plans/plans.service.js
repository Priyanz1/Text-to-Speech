import { ApiError } from '../../utils/ApiError.js';

import { PLAN_KINDS, Plan } from './plan.model.js';

/**
 * Reads of the plan catalog.
 *
 * Small, but it is the one place that knows how a plan is chosen, and both the
 * credit grant and the per-request character cap depend on getting that right.
 */

/** Active plans, cheapest first, for a pricing page. */
export async function listActivePlans() {
  const plans = await Plan.find({ isActive: true }).sort({ pricePaise: 1, credits: 1 });
  return plans.map((plan) => plan.toPublicJSON());
}

export function getFreePlan() {
  return Plan.findOne({ kind: PLAN_KINDS.FREE, isActive: true });
}

/**
 * The plan whose rules apply to a user, falling back to free.
 *
 * Throws rather than inventing defaults when nothing is configured: an invented
 * per-request character cap is an invented ceiling on what one request can cost
 * us at the provider.
 */
export async function getPlanForUser(user) {
  const plan =
    (await Plan.findOne({ slug: user.planSlug, isActive: true })) ?? (await getFreePlan());

  if (!plan) {
    throw new ApiError(503, 'No active plan is configured. Run `npm run seed` on the server.');
  }

  return plan;
}
