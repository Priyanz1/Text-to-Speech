import { z } from 'zod';

/**
 * Provider ids are opaque strings, so these schemas check shape and length only.
 *
 * Nothing here decides whether a payment is real - that is the signature check in
 * the service, which is the only thing that can. What this stops is a malformed or
 * oversized value reaching a database query or a provider call.
 */
const providerId = z.string().trim().min(4).max(120);
const signature = z.string().trim().min(16).max(256);

export const createOrderSchema = z.object({
  planSlug: z.string().trim().min(1, 'Choose a pack').max(60),
});

export const createSubscriptionSchema = z.object({
  planSlug: z.string().trim().min(1, 'Choose a plan').max(60),
});

/**
 * The field names are Razorpay's, not ours.
 *
 * Checkout's success handler hands the browser an object with exactly these keys,
 * and renaming them in the client would be one more place for a typo to become a
 * failed payment that looks like a bad signature.
 */
export const confirmPaymentSchema = z.object({
  razorpay_order_id: providerId,
  razorpay_payment_id: providerId,
  razorpay_signature: signature,
});

export const confirmSubscriptionSchema = z.object({
  razorpay_subscription_id: providerId,
  razorpay_payment_id: providerId,
  razorpay_signature: signature,
});

export const cancelSubscriptionSchema = z.object({
  // Defaults to true: cancelling immediately throws away a cycle the user has
  // already paid for, so it has to be asked for explicitly.
  atCycleEnd: z.boolean().default(true),
});
