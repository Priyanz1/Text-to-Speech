import mongoose from 'mongoose';

/**
 * One row per attempt to buy a credit pack.
 *
 * Created before the browser ever opens Checkout, and never trusted for the
 * amount afterwards. The row records what WE decided the pack costs and how many
 * credits it is worth, read from the Plan at creation time - so a client that
 * replays the callback with a different amount cannot change what gets granted.
 *
 * The webhook is the only thing that moves this to `paid` and grants credits. The
 * Checkout callback only records that the browser saw a successful payment, which
 * is a different fact: a browser that closes between the charge and the callback
 * would otherwise leave a paid order ungranted forever.
 */
export const ORDER_STATUS = {
  CREATED: 'created',
  PAID: 'paid',
  FAILED: 'failed',
};

const paymentOrderSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // The pack that was bought, by slug rather than ObjectId, for the same reason
    // User.planSlug is: a re-seeded plans collection still resolves.
    planSlug: { type: String, required: true },

    /**
     * Snapshots, not references.
     *
     * A pack's price and size are configuration and will change. An order that
     * showed today's price against a charge made under last month's would be
     * quietly wrong and unauditable - the same reasoning as the voice snapshot on
     * Generation.
     */
    credits: { type: Number, required: true, min: 1 },

    // Integer paise, never a float. 0.1 + 0.2 is not 0.3, and money that is
    // slightly wrong is worse than money that is missing.
    amountPaise: { type: Number, required: true, min: 1 },

    currency: { type: String, required: true, default: 'INR' },

    provider: { type: String, required: true, default: 'razorpay' },

    // Razorpay's order id. Unique because it is what the webhook looks the row up
    // by, and two rows sharing one would make that lookup ambiguous.
    providerOrderId: { type: String, required: true, unique: true },

    // Set by whichever of the callback or the webhook arrives first.
    providerPaymentId: { type: String, default: null },

    status: {
      type: String,
      enum: Object.values(ORDER_STATUS),
      default: ORDER_STATUS.CREATED,
      required: true,
    },

    // When credits were granted, and by which webhook event. Both null until the
    // webhook lands, which is what makes "paid but ungranted" a findable state.
    creditedAt: { type: Date, default: null },
    creditedByEventId: { type: String, default: null },

    // Safe to show the user. Set from the provider's own description on failure.
    failureReason: { type: String, default: '' },
  },
  { timestamps: true },
);

// The billing history view: one user's orders, newest first.
paymentOrderSchema.index({ userId: 1, createdAt: -1 });

paymentOrderSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    planSlug: this.planSlug,
    credits: this.credits,
    amountPaise: this.amountPaise,
    currency: this.currency,
    status: this.status,
    // The provider's ids are shown because they are what a support conversation
    // with Razorpay is conducted in.
    providerOrderId: this.providerOrderId,
    providerPaymentId: this.providerPaymentId,
    creditedAt: this.creditedAt,
    failureReason: this.failureReason,
    createdAt: this.createdAt,
  };
};

export const PaymentOrder = mongoose.model('PaymentOrder', paymentOrderSchema);
