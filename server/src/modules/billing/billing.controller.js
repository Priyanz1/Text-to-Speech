import * as billingService from './billing.service.js';

export async function getCatalog(req, res) {
  const catalog = await billingService.getCatalog();

  res.status(200).json({ success: true, data: catalog });
}

export async function createOrder(req, res) {
  const result = await billingService.createPackOrder({
    // From the access token. There is no request shape that can buy on behalf of
    // another account.
    user: req.user,
    planSlug: req.body.planSlug,
  });

  res.status(201).json({ success: true, data: result });
}

export async function confirmPayment(req, res) {
  const result = await billingService.confirmPackPayment({
    user: req.user,
    providerOrderId: req.body.razorpay_order_id,
    paymentId: req.body.razorpay_payment_id,
    signature: req.body.razorpay_signature,
  });

  res.status(200).json({ success: true, data: result });
}

/** Development only; 404s in razorpay mode. See simulatePackPayment. */
export async function simulatePayment(req, res) {
  const result = await billingService.simulatePackPayment({
    user: req.user,
    providerOrderId: req.params.orderId,
  });

  res.status(200).json({ success: true, data: result });
}

export async function createSubscription(req, res) {
  const result = await billingService.createSubscription({
    user: req.user,
    planSlug: req.body.planSlug,
  });

  res.status(201).json({ success: true, data: result });
}

export async function confirmSubscription(req, res) {
  const result = await billingService.confirmSubscription({
    user: req.user,
    providerSubscriptionId: req.body.razorpay_subscription_id,
    paymentId: req.body.razorpay_payment_id,
    signature: req.body.razorpay_signature,
  });

  res.status(200).json({ success: true, data: result });
}

export async function cancelSubscription(req, res) {
  const subscription = await billingService.cancelSubscription({
    user: req.user,
    providerSubscriptionId: req.params.subscriptionId,
    atCycleEnd: req.body.atCycleEnd,
  });

  res.status(200).json({ success: true, data: { subscription } });
}

export async function resumeSubscription(req, res) {
  const subscription = await billingService.resumeSubscription({
    user: req.user,
    providerSubscriptionId: req.params.subscriptionId,
  });

  res.status(200).json({ success: true, data: { subscription } });
}

/** Both histories in one response: the billing page shows them together. */
export async function getHistory(req, res) {
  const [payments, subscriptions] = await Promise.all([
    billingService.listPayments({ userId: req.user._id }),
    billingService.listSubscriptions({ userId: req.user._id }),
  ]);

  res.status(200).json({ success: true, data: { payments, subscriptions } });
}
