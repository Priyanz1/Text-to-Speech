import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      // Uniqueness is only meaningful if the stored form is canonical, so email
      // is lowercased both here and in the Zod schema before it ever gets here.
    },

    // select: false keeps the hash out of every query result unless a caller
    // explicitly asks for it with .select('+passwordHash'). One line that makes
    // accidentally serialising it to a response very hard.
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },

    // A date rather than a boolean: same storage cost, and knowing *when*
    // someone verified is useful later.
    emailVerifiedAt: {
      type: Date,
      default: null,
    },

    // Admin is granted by editing the database directly. No endpoint anywhere
    // writes this field - see the update whitelist in users.service.js.
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user',
    },

    /**
     * Credit balances, in two buckets, spent subscription-first.
     *
     * Plain numbers rather than a nested object because that is what `$inc` and
     * the conditional atomic update in credits.service.js operate on - a
     * read-then-write would let two concurrent generations both spend the last
     * credits.
     *
     * These are a CACHE. The append-only CreditTransaction ledger is the source
     * of truth, and reconcile() checks the two still agree.
     */
    subscriptionCredits: { type: Number, default: 0, min: 0 },

    // Bought outright, so they never expire. Drained only after subscription
    // credits, which do.
    purchasedCredits: { type: Number, default: 0, min: 0 },

    // Which Plan's rules apply to this account. A slug rather than an ObjectId
    // so a fresh database with a re-seeded plans collection still resolves.
    planSlug: { type: String, default: 'free' },

    // Set the first time the signup grant lands, so it cannot land twice even if
    // the ledger's idempotency key were somehow lost.
    signupCreditsGrantedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/**
 * The only shape of a user that is ever sent to a client.
 *
 * Building the response explicitly, rather than deleting fields from the
 * document, means a field added to the schema later is invisible by default
 * instead of leaking until someone notices.
 */
userSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    name: this.name,
    email: this.email,
    role: this.role,
    emailVerified: this.emailVerifiedAt !== null,
    planSlug: this.planSlug,
    // Carried on every session response so the balance the UI shows is refreshed
    // by login, /me and refresh without a second request. The product rule is
    // that the balance never goes stale after a generation.
    credits: {
      subscription: this.subscriptionCredits,
      purchased: this.purchasedCredits,
      total: this.subscriptionCredits + this.purchasedCredits,
    },
    createdAt: this.createdAt,
  };
};

export const User = mongoose.model('User', userSchema);
