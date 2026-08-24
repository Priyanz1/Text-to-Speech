import mongoose from 'mongoose';

/**
 * One row per subscription, mirroring the provider's state machine.
 *
 * The states are Razorpay's own, because inventing a parallel vocabulary would
 * mean a mapping table that can drift from what the webhooks actually say:
 *
 *   created        - we asked for it; the customer has not authorised the mandate.
 *   authenticated  - mandate authorised, first charge not made yet.
 *   active         - charging normally. This is the only state that grants credits.
 *   pending        - a charge failed and the provider is retrying. The subscription
 *                    is not dead; nothing should be revoked here.
 *   halted         - the retries ran out. Needs the customer to act.
 *   cancelled      - terminal. Razorpay has no un-cancel; a new subscription is
 *                    the only way back.
 *   completed      - ran to its agreed total_count and ended normally.
 *   paused         - suspended and resumable. This is what `resume` acts on.
 *   expired        - the authorisation window elapsed before it was authenticated.
 *
 * Credits are granted only on `subscription.charged`, and only through the ledger.
 * Nothing here grants anything by itself.
 */
export const SUBSCRIPTION_STATUS = {
  CREATED: 'created',
  AUTHENTICATED: 'authenticated',
  ACTIVE: 'active',
  PENDING: 'pending',
  HALTED: 'halted',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed',
  PAUSED: 'paused',
  EXPIRED: 'expired',
};

/** The states in which a subscription is still worth something to the user. */
export const LIVE_SUBSCRIPTION_STATUSES = [
  SUBSCRIPTION_STATUS.CREATED,
  SUBSCRIPTION_STATUS.AUTHENTICATED,
  SUBSCRIPTION_STATUS.ACTIVE,
  SUBSCRIPTION_STATUS.PENDING,
  SUBSCRIPTION_STATUS.PAUSED,
];

const subscriptionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    planSlug: { type: String, required: true },

    // Snapshot of what one cycle is worth, for the same reason PaymentOrder
    // snapshots its credits: the plan's allowance will be recalibrated, and a
    // charge has to stay auditable against the number that was in force.
    creditsPerCycle: { type: Number, required: true, min: 0 },
    amountPaise: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, default: 'INR' },

    provider: { type: String, required: true, default: 'razorpay' },

    // Unique: this is what every webhook resolves the row by.
    providerSubscriptionId: { type: String, required: true, unique: true },
    providerPlanId: { type: String, default: null },

    status: {
      type: String,
      enum: Object.values(SUBSCRIPTION_STATUS),
      default: SUBSCRIPTION_STATUS.CREATED,
      required: true,
    },

    // The provider's view of the current billing period, refreshed by webhooks.
    currentStart: { type: Date, default: null },
    currentEnd: { type: Date, default: null },
    chargeAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },

    /**
     * A cancel that takes effect at the end of the paid-for cycle.
     *
     * Kept separately from `status` because Razorpay leaves such a subscription
     * `active` until the period runs out - which is correct, the user paid for it -
     * so status alone cannot answer "is this going to renew".
     */
    cancelAtCycleEnd: { type: Boolean, default: false },

    // How many cycles have actually been paid, and when the last one landed. Both
    // come from the charged webhook rather than being counted here.
    cyclesPaid: { type: Number, default: 0, min: 0 },
    lastChargedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

subscriptionSchema.index({ userId: 1, createdAt: -1 });

subscriptionSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    planSlug: this.planSlug,
    creditsPerCycle: this.creditsPerCycle,
    amountPaise: this.amountPaise,
    currency: this.currency,
    status: this.status,
    providerSubscriptionId: this.providerSubscriptionId,
    currentStart: this.currentStart,
    currentEnd: this.currentEnd,
    chargeAt: this.chargeAt,
    endedAt: this.endedAt,
    cancelAtCycleEnd: this.cancelAtCycleEnd,
    cyclesPaid: this.cyclesPaid,
    lastChargedAt: this.lastChargedAt,
    // Derived rather than stored, so it cannot disagree with the status it is
    // derived from.
    isLive: LIVE_SUBSCRIPTION_STATUSES.includes(this.status),
    canResume: this.status === SUBSCRIPTION_STATUS.PAUSED,
    createdAt: this.createdAt,
  };
};

export const Subscription = mongoose.model('Subscription', subscriptionSchema);
