import mongoose from 'mongoose';

/**
 * Email verification, password reset and refresh tokens in one collection,
 * separated by `type`. They share every field that matters: who it belongs to,
 * a hash, an expiry, and whether it has been used or revoked.
 *
 * Only hashes are stored. A dump of this collection is therefore not enough to
 * take over an account, and we cannot email a user their own token back.
 */
export const TOKEN_TYPES = {
  REFRESH: 'refresh',
  EMAIL_VERIFY: 'email_verify',
  PASSWORD_RESET: 'password_reset',
};

const tokenSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    type: {
      type: String,
      enum: Object.values(TOKEN_TYPES),
      required: true,
    },

    // SHA-256 of the token we sent out. Unique because a collision would mean
    // one token authenticating two sessions.
    tokenHash: {
      type: String,
      required: true,
      unique: true,
    },

    // Refresh tokens only. Every token descended from one login shares a family
    // id, which is what makes "revoke the whole session on replay" possible.
    familyId: {
      type: String,
      default: null,
      index: true,
    },

    // Set the moment a token is consumed. For single-use tokens this is what
    // makes them single-use; for refresh tokens, presenting an already-used one
    // is the signal that it was stolen.
    usedAt: {
      type: Date,
      default: null,
    },

    revokedAt: {
      type: Date,
      default: null,
    },

    // MongoDB deletes expired documents automatically, but its TTL monitor only
    // runs about once a minute, so a token can outlive its expiry by up to that
    // long. The TTL index is housekeeping; every read also checks expiresAt.
    expiresAt: {
      type: Date,
      required: true,
      expires: 0,
    },
  },
  { timestamps: true },
);

export const Token = mongoose.model('Token', tokenSchema);
