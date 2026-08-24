import { Router } from 'express';

import { paymentRateLimit } from '../../middleware/rateLimit.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { validate } from '../../middleware/validate.js';

import * as billingController from './billing.controller.js';
import {
  cancelSubscriptionSchema,
  confirmPaymentSchema,
  confirmSubscriptionSchema,
  createOrderSchema,
  createSubscriptionSchema,
} from './billing.validation.js';

export const billingRouter = Router();

/**
 * Everything a signed-in user does with money. The webhook is NOT here - it has no
 * session and cannot be behind requireAuth, so it lives on its own router with a
 * raw body parser.
 *
 * paymentRateLimit is per-user and only on the routes that call the provider or
 * check a signature. Reads are left to the global limiter: rate-limiting the
 * billing page itself would break the page whose job is to show a user why their
 * payment has not appeared yet.
 */
billingRouter.get('/catalog', requireAuth, billingController.getCatalog);

billingRouter.get('/history', requireAuth, billingController.getHistory);

billingRouter.post(
  '/orders',
  requireAuth,
  paymentRateLimit,
  validate(createOrderSchema),
  billingController.createOrder,
);

// Records that the browser saw a success. Grants nothing - the webhook does that.
billingRouter.post(
  '/orders/verify',
  requireAuth,
  paymentRateLimit,
  validate(confirmPaymentSchema),
  billingController.confirmPayment,
);

/**
 * Development only. 404s whenever PAYMENT_PROVIDER is razorpay, because the
 * mock's signWebhook is undefined there - so this cannot be a live endpoint that
 * mints credits.
 */
billingRouter.post(
  '/orders/:orderId/simulate',
  requireAuth,
  paymentRateLimit,
  billingController.simulatePayment,
);

billingRouter.post(
  '/subscriptions',
  requireAuth,
  paymentRateLimit,
  validate(createSubscriptionSchema),
  billingController.createSubscription,
);

billingRouter.post(
  '/subscriptions/verify',
  requireAuth,
  paymentRateLimit,
  validate(confirmSubscriptionSchema),
  billingController.confirmSubscription,
);

billingRouter.post(
  '/subscriptions/:subscriptionId/cancel',
  requireAuth,
  paymentRateLimit,
  validate(cancelSubscriptionSchema),
  billingController.cancelSubscription,
);

billingRouter.post(
  '/subscriptions/:subscriptionId/resume',
  requireAuth,
  paymentRateLimit,
  billingController.resumeSubscription,
);
