import mongoose from 'mongoose';

/**
 * One entry in the curated voice catalog.
 *
 * The important thing about this model is what is NOT in it: no price. Provider
 * rates change, and a rate compiled into the application would need a deploy to
 * correct. `tier` and `costMultiplier` are configuration read from here at
 * request time - see DECISIONS.md §1, which forbids hard-coding either.
 *
 * The catalog is seeded from the provider (scripts/seed.js) and then owned by
 * us: the seeder refreshes descriptive fields but never overwrites the two
 * fields below, so a calibrated multiplier survives a re-seed.
 */
const voiceSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true, default: 'google' },

    // The id the provider expects, e.g. 'en-US-Neural2-F'.
    providerVoiceId: { type: String, required: true, trim: true },

    // What the user sees. Defaults to the provider id, editable later.
    name: { type: String, required: true, trim: true },

    // The locale this voice is offered under, e.g. 'en-US'. Providers can list
    // one voice under several; this is the one we present it as.
    languageCode: { type: String, required: true, trim: true, index: true },

    // Every locale the provider lists for this voice, kept for reference.
    languageCodes: { type: [String], default: [] },

    // Human label such as "American English", resolved once at seed time so the
    // client does not need an i18n table to render a dropdown.
    languageName: { type: String, default: '' },

    gender: {
      type: String,
      enum: ['MALE', 'FEMALE', 'NEUTRAL', 'UNSPECIFIED'],
      default: 'UNSPECIFIED',
    },

    // The provider's product family - 'standard', 'wavenet', 'neural2',
    // 'studio', 'chirp3-hd', ... This is derived from the voice's NAME, which is
    // a naming fact, not a price. Plans allow or deny whole tiers, and pricing
    // calibration sets a multiplier per tier.
    tier: { type: String, required: true, default: 'other', index: true },

    /**
     * Credits charged per character of input, relative to the base rate.
     *
     * Seeded at 1 for every voice on purpose. A seeded value that looked like a
     * real price would become exactly the hard-coded pricing DECISIONS.md §1
     * rules out - the numbers here are set during the pricing calibration step,
     * from Google's published rates read on a recorded date.
     */
    costMultiplier: { type: Number, required: true, default: 1, min: 0 },

    naturalSampleRateHertz: { type: Number, default: null },

    // Lets a voice be retired from the catalog without deleting it, so old
    // Generation records still resolve to something.
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// One document per voice per provider. Two providers may legitimately use the
// same id, so the pair is what has to be unique.
voiceSchema.index({ provider: 1, providerVoiceId: 1 }, { unique: true });

// Backs the voice list for a chosen language, which is the only query the
// client makes against this collection.
voiceSchema.index({ languageCode: 1, isActive: 1 });

voiceSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    voiceId: this.providerVoiceId,
    name: this.name,
    languageCode: this.languageCode,
    languageName: this.languageName,
    gender: this.gender,
    tier: this.tier,
    // Exposed so the client can show the cost of a generation before it runs -
    // the product rule is that the price is always visible before the action.
    costMultiplier: this.costMultiplier,
  };
};

export const Voice = mongoose.model('Voice', voiceSchema);
