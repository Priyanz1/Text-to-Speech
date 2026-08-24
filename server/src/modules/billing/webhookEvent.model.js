import mongoose from 'mongoose';

/**
 * Every webhook delivery we have seen, and what came of it.
 *
 * This is the replay guard. Razorpay retries a delivery it did not get a 2xx for,
 * and it can also deliver the same event twice for reasons that are none of our
 * business, so "process this event" has to mean "process this event at most once".
 *
 * There are two independent layers stopping a double grant, on purpose:
 *
 *   1. This collection. A unique index on providerEventId means the second
 *      delivery of one event cannot even be claimed.
 *   2. The credit ledger's own unique idempotencyKey. Even if this guard were
 *      bypassed entirely - a new code path, a manual replay, a bug here - the
 *      ledger row collides and no credits move.
 *
 * One layer would be enough right up until it wasn't. The second costs a unique
 * index.
 */
export const WEBHOOK_STATUS = {
  // Claimed by a delivery that has not finished. A row stuck here is a process
  // that died mid-handling; see PROCESSING_GRACE_MS in the service.
  PROCESSING: 'processing',
  PROCESSED: 'processed',
  // Handled and deliberately did nothing - an event type we do not act on. Kept
  // rather than discarded so "why did nothing happen" has an answer.
  IGNORED: 'ignored',
  // Our handler threw. Left in this state so the provider's next retry reclaims
  // and reprocesses it instead of being told it is already done.
  FAILED: 'failed',
};

const webhookEventSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true, default: 'razorpay' },

    /**
     * The provider's own id for this delivery, from the X-Razorpay-Event-Id
     * header.
     *
     * Unique, and that index is the whole point of this collection. When the
     * header is absent the service falls back to a hash of the raw body, which is
     * deterministic - so a byte-identical replay still collides.
     */
    providerEventId: { type: String, required: true, unique: true },

    // 'payment.captured', 'subscription.charged', and so on.
    event: { type: String, required: true },

    status: {
      type: String,
      enum: Object.values(WEBHOOK_STATUS),
      default: WEBHOOK_STATUS.PROCESSING,
      required: true,
    },

    // The order or subscription this event was about, when it named one. Only for
    // reading logs; nothing branches on it.
    subjectId: { type: String, default: null },

    // How many deliveries of this event have reached the handler. Above 1 means
    // the provider retried, which usually means our first attempt failed.
    attempts: { type: Number, default: 1, min: 1 },

    processedAt: { type: Date, default: null },

    // The message from a thrown handler. Never sent to a client - the webhook's
    // caller is Razorpay, and it only needs a status code.
    error: { type: String, default: '' },
  },
  { timestamps: true },
);

// Admin's payment overview reads recent deliveries, newest first.
webhookEventSchema.index({ createdAt: -1 });

webhookEventSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    event: this.event,
    status: this.status,
    subjectId: this.subjectId,
    attempts: this.attempts,
    processedAt: this.processedAt,
    error: this.error,
    createdAt: this.createdAt,
  };
};

export const WebhookEvent = mongoose.model('WebhookEvent', webhookEventSchema);
