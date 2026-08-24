import { env } from '../../config/env.js';

import * as mock from './mock.js';
import * as razorpay from './razorpay.js';

/**
 * The only way the rest of the codebase reaches a payment provider.
 *
 * Same shape as integrations/ttsProvider and integrations/email: two transports
 * chosen by one env var, and nothing above this file learns which is live.
 *
 *   mock      - local ids and locally signed webhooks. No account, no network, no
 *               money. The whole grant path is still real.
 *   razorpay  - the real API. Test or live depending on the key pair.
 *
 * Adding Stripe means one more module here and one more enum value in
 * config/env.js.
 */
const provider = env.PAYMENT_PROVIDER === 'razorpay' ? razorpay : mock;

export const {
  createOrder,
  createSubscription,
  fetchSubscription,
  cancelSubscription,
  resumeSubscription,
  verifyPaymentSignature,
  verifySubscriptionSignature,
  verifyWebhookSignature,
  describe,
  publicKeyId,
} = provider;

/**
 * Present only on the mock adapter, and the way the service decides whether the
 * simulate-payment route exists at all: `undefined` in razorpay mode, so the
 * route answers 404 rather than being a live endpoint that mints credits.
 */
export const signWebhook = provider.signWebhook;
export const simulateCheckout = provider.simulateCheckout;

export const providerName = env.PAYMENT_PROVIDER;
export const isMock = env.PAYMENT_PROVIDER === 'mock';
