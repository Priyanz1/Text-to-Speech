import * as plansService from './plans.service.js';

/**
 * Public: the pricing page has to be readable before anyone signs up.
 *
 * toPublicJSON on the model is what keeps internal fields (providerPlanId,
 * creditRenewalPolicy) out of this response.
 */
export async function listPlans(req, res) {
  const plans = await plansService.listActivePlans();

  res.status(200).json({ success: true, data: { plans } });
}
