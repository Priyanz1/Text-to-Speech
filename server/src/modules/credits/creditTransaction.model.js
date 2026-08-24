import mongoose from 'mongoose';

/**
 * The append-only credit ledger. Never updated, never deleted.
 *
 * The balances on `User` are a cache that exists so a page load does not have to
 * sum this collection. This is the source of truth, which is what makes
 * "where did my credits go" answerable and makes the cache verifiable:
 * SUM(amount) per bucket must equal the matching balance on User. See
 * credits.service.js reconcile().
 */
export const LEDGER_TYPES = {
  SIGNUP_GRANT: 'signup_grant',
  GENERATION_CHARGE: 'generation_charge',
  GENERATION_REFUND: 'generation_refund',
  PURCHASE: 'purchase',
  ADMIN_ADJUSTMENT: 'admin_adjustment',
  // Reserved for whichever subscription renewal policy is eventually chosen.
  // DECISIONS.md §2 is still open, so nothing writes this yet.
  EXPIRY: 'expiry',
};

export const BUCKETS = {
  SUBSCRIPTION: 'subscription',
  PURCHASED: 'purchased',
};

const creditTransactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    type: {
      type: String,
      enum: Object.values(LEDGER_TYPES),
      required: true,
    },

    // Which of the two balances moved. A charge that spans both buckets writes
    // one row per bucket rather than one ambiguous row.
    bucket: {
      type: String,
      enum: Object.values(BUCKETS),
      required: true,
    },

    // Signed: negative spends, positive grants. Integers only - a credit is one
    // character of input text, and there is no such thing as half a character.
    amount: {
      type: Number,
      required: true,
      validate: {
        validator: Number.isInteger,
        message: 'amount must be a whole number of credits',
      },
    },

    // That bucket's balance immediately after this row was written. Redundant
    // with the running sum, and worth the redundancy: it turns "the numbers
    // disagree" into "they diverged at this row".
    balanceAfter: { type: Number, required: true },

    /**
     * What makes this row happen exactly once.
     *
     * Every writer derives a deterministic key from what it is doing
     * ('signup-grant:<userId>', 'charge:<generationId>:<bucket>'), so a retry, a
     * double-click, or two webhook deliveries of the same event collide on the
     * unique index instead of moving credits twice.
     */
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
    },

    generationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Generation',
      default: null,
    },

    note: { type: String, default: '' },
  },
  { timestamps: true },
);

// The ledger view: one user's rows, newest first.
creditTransactionSchema.index({ userId: 1, createdAt: -1 });

creditTransactionSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    type: this.type,
    bucket: this.bucket,
    amount: this.amount,
    balanceAfter: this.balanceAfter,
    generationId: this.generationId?.toString() ?? null,
    note: this.note,
    createdAt: this.createdAt,
  };
};

export const CreditTransaction = mongoose.model('CreditTransaction', creditTransactionSchema);
