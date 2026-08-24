import mongoose from 'mongoose';

export const GENERATION_STATUS = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

const generationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // The submitted text. This is user content: it is stored so a generation can
    // be replayed, and it is never written to the log or to any third-party log
    // collector.
    text: { type: String, required: true },

    // Both, because they answer different questions. Characters are what we
    // charge for; UTF-8 bytes are what the provider limits. For "café" those are
    // 4 and 5.
    charCount: { type: Number, required: true, min: 1 },
    byteLength: { type: Number, required: true, min: 1 },

    /**
     * A snapshot of the voice as it was when this ran, not a reference to it.
     *
     * costMultiplier is configuration and will be recalibrated. A history row
     * that showed today's multiplier against a charge made under last month's
     * would be quietly wrong, and unauditable.
     */
    voice: {
      voiceId: { type: String, required: true },
      provider: { type: String, required: true },
      name: { type: String, default: '' },
      languageCode: { type: String, default: '' },
      tier: { type: String, default: '' },
      costMultiplier: { type: Number, required: true },
    },

    creditsCharged: { type: Number, required: true, min: 0 },

    // Which buckets the charge came out of, so a refund puts it back where it
    // came from instead of quietly converting subscription credits into
    // purchased ones (which do not expire).
    creditSplit: {
      subscription: { type: Number, default: 0, min: 0 },
      purchased: { type: Number, default: 0, min: 0 },
    },

    creditsRefunded: { type: Number, default: 0, min: 0 },

    status: {
      type: String,
      enum: Object.values(GENERATION_STATUS),
      default: GENERATION_STATUS.PENDING,
      required: true,
    },

    // Safe to show the user: set from ApiError messages and provider failures
    // that have been reduced to a sentence.
    failureReason: { type: String, default: '' },

    audio: {
      // Opaque key for the storage adapter. A local path today, an S3 object key
      // later; nothing outside integrations/storage may interpret it.
      storageKey: { type: String, default: null },
      mimeType: { type: String, default: null },
      encoding: { type: String, default: null },
      byteSize: { type: Number, default: null },
    },

    /**
     * Client-supplied, one per submit attempt.
     *
     * `sparse` because most requests will not send one, and a unique index would
     * otherwise reject every document after the first null. With it, a retried
     * request collides here and returns the original generation rather than
     * charging a second time.
     *
     * There is deliberately no `default: null`: a sparse index skips documents
     * that do not CONTAIN the field, not documents where it is null. A default
     * would put `idempotencyKey: null` on every keyless generation, index them
     * all, and make the second one a duplicate-key error. The field has to be
     * absent, so callers omit it rather than passing null.
     */
    idempotencyKey: {
      type: String,
      unique: true,
      sparse: true,
    },
  },
  { timestamps: true },
);

// The history view: one user's generations, newest first.
generationSchema.index({ userId: 1, createdAt: -1 });

generationSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    text: this.text,
    charCount: this.charCount,
    byteLength: this.byteLength,
    voice: {
      voiceId: this.voice.voiceId,
      name: this.voice.name,
      languageCode: this.voice.languageCode,
      tier: this.voice.tier,
    },
    creditsCharged: this.creditsCharged,
    creditsRefunded: this.creditsRefunded,
    status: this.status,
    failureReason: this.failureReason,
    mimeType: this.audio.mimeType,
    byteSize: this.audio.byteSize,
    // A path, not a signed URL. The client fetches it with the same access token
    // it uses everywhere else; ownership is checked server-side on every read.
    audioUrl: this.audio.storageKey ? `/api/tts/generations/${this._id.toString()}/audio` : null,
    createdAt: this.createdAt,
  };
};

/**
 * The history list carries a preview instead of the whole text.
 *
 * A page of 20 rows at the plan's 2000-character cap is 40 KB of text nobody
 * reads on a list screen. The full text is one request away (GET /:id), which is
 * where a "view" or a "generate again" action reads it from.
 */
const PREVIEW_CHARS = 160;

generationSchema.methods.toListJSON = function toListJSON() {
  const { text, ...rest } = this.toPublicJSON();

  return {
    ...rest,
    // Spread rather than slice(), so a preview cannot end halfway through an
    // astral character and render as a replacement glyph.
    textPreview: [...text].slice(0, PREVIEW_CHARS).join(''),
    textTruncated: [...text].length > PREVIEW_CHARS,
  };
};

export const Generation = mongoose.model('Generation', generationSchema);
