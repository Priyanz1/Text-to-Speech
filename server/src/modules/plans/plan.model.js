import mongoose from 'mongoose';

/**
 * A tier: the free grant, a one-time credit pack, or a subscription.
 *
 * This exists now, before there is any billing, because two things have to read
 * from it immediately: the size of the signup grant, and the per-request
 * character cap. Both are business numbers, and business numbers belong in the
 * database where they can be changed without a deploy - see DECISIONS.md §1.
 */
export const PLAN_KINDS = {
  FREE: 'free',
  CREDIT_PACK: 'credit_pack',
  SUBSCRIPTION: 'subscription',
};

/**
 * What happens to unused subscription credits at the end of a cycle.
 *
 * DECISIONS.md §2 records this as an OPEN question. The enum exists so the
 * choice has somewhere to live; nothing reads it yet, and no code anywhere may
 * assume which of these is correct.
 */
export const RENEWAL_POLICIES = {
  NOT_APPLICABLE: 'not_applicable',
  RESET: 'reset',
  ROLLOVER: 'rollover',
  PARTIAL_ROLLOVER: 'partial_rollover',
};

const planSchema = new mongoose.Schema(
  {
    // Stable identifier used in code and on User.planSlug. Names and prices
    // change; this must not.
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    name: { type: String, required: true, trim: true },

    kind: {
      type: String,
      enum: Object.values(PLAN_KINDS),
      required: true,
    },

    // Credits this plan hands out: the signup grant for `free`, the pack size
    // for `credit_pack`, the per-cycle allowance for `subscription`.
    credits: { type: Number, required: true, min: 0 },

    // Integer paise, never a float - 0.1 + 0.2 is not 0.3, and money that is
    // slightly wrong is worse than money that is missing. Zero for `free`.
    pricePaise: { type: Number, required: true, min: 0, default: 0 },

    // null means "not decided yet", which is the honest state: whether the
    // displayed price includes GST is still open (DECISIONS.md §4).
    gstIncluded: { type: Boolean, default: null },

    creditRenewalPolicy: {
      type: String,
      enum: Object.values(RENEWAL_POLICIES),
      default: RENEWAL_POLICIES.NOT_APPLICABLE,
    },

    // Only meaningful for PARTIAL_ROLLOVER. Unset until the policy is chosen.
    rolloverCapCredits: { type: Number, default: null, min: 0 },

    // Razorpay's id for the matching plan, filled in when billing is built.
    providerPlanId: { type: String, default: null },

    // Per-request ceiling on input length, in characters. A cap per plan is the
    // first line of defence against cost-amplification abuse: every generation
    // spends real provider money.
    maxCharsPerRequest: { type: Number, required: true, min: 1 },

    // Voice tiers this plan may use, by Voice.tier. Empty means "all of them".
    // Kept as tier names rather than voice ids so adding a voice to the catalog
    // does not mean editing every plan.
    allowedVoiceTiers: { type: [String], default: [] },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

planSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    slug: this.slug,
    name: this.name,
    kind: this.kind,
    credits: this.credits,
    pricePaise: this.pricePaise,
    gstIncluded: this.gstIncluded,
    maxCharsPerRequest: this.maxCharsPerRequest,
    allowedVoiceTiers: this.allowedVoiceTiers,
  };
};

export const Plan = mongoose.model('Plan', planSchema);
