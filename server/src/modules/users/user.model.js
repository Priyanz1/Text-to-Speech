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
    createdAt: this.createdAt,
  };
};

export const User = mongoose.model('User', userSchema);
