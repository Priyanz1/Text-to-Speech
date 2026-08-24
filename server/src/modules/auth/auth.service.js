import crypto from 'node:crypto';

import bcrypt from 'bcryptjs';

import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendEmail } from '../../integrations/email/index.js';
import {
  accountExistsEmail,
  clientUrls,
  passwordResetEmail,
  verificationEmail,
} from '../../integrations/email/templates.js';
import { User } from '../users/user.model.js';
import { grantSignupCredits } from '../credits/credits.service.js';
import { TOKEN_TYPES, Token } from './token.model.js';
import {
  createOpaqueToken,
  daysFromNow,
  hashToken,
  minutesFromNow,
  signAccessToken,
} from './auth.tokens.js';

/**
 * A real bcrypt hash of a throwaway value, used when a login attempt names an
 * address that has no account.
 *
 * Without it, a missing user returns before any hashing happens and a present
 * user pays a few hundred milliseconds - a difference an attacker can measure to
 * enumerate registered addresses. Comparing against this instead makes both
 * paths cost the same.
 *
 * Computed once at import, at the same cost factor as real passwords, because a
 * cheaper dummy hash would leak the same timing difference it exists to hide.
 */
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('timing-attack-placeholder', env.BCRYPT_COST);

/**
 * Email is fire-and-forget from the caller's point of view.
 *
 * A provider outage must not turn signup into a 500 - the account was created,
 * and reporting failure would suggest otherwise. For forgot-password there is a
 * second reason: the response has to be identical whether or not the address is
 * registered, so it cannot depend on whether an email went out.
 */
async function trySendEmail(to, message) {
  try {
    await sendEmail({ to, ...message });
  } catch (error) {
    logger.error('Failed to send email', { to, subject: message.subject, message: error.message });
  }
}

/** Replaces any unused token of this type, so only the newest link works. */
async function issueSingleUseToken(user, type, ttlMinutes) {
  await Token.updateMany(
    { userId: user._id, type, usedAt: null, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );

  const { token, tokenHash } = createOpaqueToken();

  await Token.create({
    userId: user._id,
    type,
    tokenHash,
    expiresAt: minutesFromNow(ttlMinutes),
  });

  return token;
}

async function sendVerificationEmail(user) {
  const token = await issueSingleUseToken(
    user,
    TOKEN_TYPES.EMAIL_VERIFY,
    env.VERIFY_TOKEN_TTL_MINUTES,
  );

  await trySendEmail(
    user.email,
    verificationEmail({
      name: user.name,
      url: clientUrls.verifyEmail(token),
      ttlMinutes: env.VERIFY_TOKEN_TTL_MINUTES,
    }),
  );
}

/**
 * Starts a session: one refresh token, and the access token that goes with it.
 *
 * `familyId` ties every token descended from this login together. Rotation keeps
 * the family and replaces the token, so revoking a family ends the whole session
 * however many times it has rotated since.
 */
async function startSession(user, familyId = crypto.randomUUID()) {
  const { token, tokenHash } = createOpaqueToken();

  await Token.create({
    userId: user._id,
    type: TOKEN_TYPES.REFRESH,
    tokenHash,
    familyId,
    expiresAt: daysFromNow(env.REFRESH_TOKEN_TTL_DAYS),
  });

  return {
    user,
    accessToken: signAccessToken(user),
    refreshToken: token,
  };
}

async function revokeFamily(familyId, reason) {
  const result = await Token.updateMany(
    { familyId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );

  logger.warn('Revoked refresh token family', { reason, revoked: result.modifiedCount });
}

/**
 * Creates an account, or pretends to.
 *
 * The response is identical whether or not the address is already registered, so
 * signup cannot be used to find out who has an account. The person who owns the
 * address still finds out, by email - see accountExistsEmail.
 */
export async function signup({ name, email, password }) {
  const existing = await User.findOne({ email });

  if (existing) {
    logger.info('Signup attempted for an existing address');

    await trySendEmail(
      existing.email,
      accountExistsEmail({
        name: existing.name,
        loginUrl: clientUrls.login(),
        resetUrl: clientUrls.forgotPassword(),
      }),
    );

    return;
  }

  const passwordHash = await bcrypt.hash(password, env.BCRYPT_COST);

  let user;
  try {
    user = await User.create({ name, email, passwordHash });
  } catch (error) {
    // Two signups for the same new address at once: both passed the check above,
    // then the unique index on email rejected the second. That is the same
    // situation as `existing` and must look the same from outside.
    if (error.code === 11_000) {
      logger.info('Signup lost a race on a duplicate address');
      return;
    }
    throw error;
  }

  logger.info('User signed up', { userId: user._id.toString() });
  await sendVerificationEmail(user);
}

export async function login({ email, password }) {
  // passwordHash is select:false on the schema, so it has to be asked for.
  const user = await User.findOne({ email }).select('+passwordHash');

  const matches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);

  if (!user || !matches) {
    // One message for both causes. "No account with that email" would confirm
    // which addresses are registered.
    throw new ApiError(401, 'Incorrect email or password');
  }

  logger.info('User logged in', { userId: user._id.toString() });
  return startSession(user);
}

/**
 * Rotates a refresh token, and treats a replay as a stolen token.
 *
 * The claim is a single findOneAndUpdate with `usedAt: null` in the filter, which
 * makes it atomic: two requests arriving with the same token cannot both succeed,
 * because MongoDB applies the update to one document at a time. Reading first and
 * writing second would let both through and leave two live tokens in one family.
 */
export async function refresh(rawToken) {
  if (!rawToken) throw new ApiError(401, 'Not authenticated');

  const tokenHash = hashToken(rawToken);
  const now = new Date();

  const claimed = await Token.findOneAndUpdate(
    {
      tokenHash,
      type: TOKEN_TYPES.REFRESH,
      usedAt: null,
      revokedAt: null,
      expiresAt: { $gt: now },
    },
    { $set: { usedAt: now } },
    { new: true },
  );

  if (!claimed) {
    // Work out why it failed. A token that exists and was already used is the
    // one case that matters: either it leaked, or a client is retrying. We cannot
    // tell the difference, so we assume the worse of the two and end the session.
    const stale = await Token.findOne({ tokenHash, type: TOKEN_TYPES.REFRESH });

    if (stale?.usedAt && stale.familyId) {
      await revokeFamily(stale.familyId, 'refresh token reuse detected');
    }

    throw new ApiError(401, 'Session expired, please sign in again');
  }

  const user = await User.findById(claimed.userId);

  if (!user) {
    // The account was deleted while the session was live.
    await revokeFamily(claimed.familyId, 'user no longer exists');
    throw new ApiError(401, 'Session expired, please sign in again');
  }

  return startSession(user, claimed.familyId);
}

export async function logout(rawToken) {
  if (!rawToken) return;

  const token = await Token.findOne({
    tokenHash: hashToken(rawToken),
    type: TOKEN_TYPES.REFRESH,
  });

  if (!token) return;

  // Revoke the family, not just this token. Logging out should end the session,
  // and any token already rotated out of this one belongs to the same session.
  await revokeFamily(token.familyId, 'logout');
}

export async function verifyEmail(rawToken) {
  const claimed = await Token.findOneAndUpdate(
    {
      tokenHash: hashToken(rawToken),
      type: TOKEN_TYPES.EMAIL_VERIFY,
      usedAt: null,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    },
    { $set: { usedAt: new Date() } },
    { new: true },
  );

  if (!claimed) {
    throw new ApiError(400, 'This verification link is invalid or has expired');
  }

  const user = await User.findById(claimed.userId);
  if (!user) throw new ApiError(400, 'This verification link is invalid or has expired');

  // Already verified through another link: nothing to do, but not an error.
  if (user.emailVerifiedAt === null) {
    // Granted BEFORE the flag is set, on purpose. resendVerification returns
    // early for an already-verified address, so a grant that failed after the
    // flag was written would leave the account verified, ungranted, and with no
    // way to ask for another link. The grant is idempotent, so the reverse order
    // costs nothing.
    await grantSignupCredits(user);

    user.emailVerifiedAt = new Date();
    await user.save();
    logger.info('Email verified', { userId: user._id.toString() });

    // Re-read: the grant updated the balance with its own atomic write, so this
    // document's copy of it is stale - and this document is what the response,
    // including the credit balance, is built from.
    return (await User.findById(user._id)) ?? user;
  }

  return user;
}

/** Always looks the same from outside, whether or not the address is registered. */
export async function resendVerification(email) {
  const user = await User.findOne({ email });

  if (!user || user.emailVerifiedAt !== null) return;

  await sendVerificationEmail(user);
}

/** Always looks the same from outside, whether or not the address is registered. */
export async function forgotPassword(email) {
  const user = await User.findOne({ email });

  if (!user) {
    logger.info('Password reset requested for an unknown address');
    return;
  }

  const token = await issueSingleUseToken(
    user,
    TOKEN_TYPES.PASSWORD_RESET,
    env.RESET_TOKEN_TTL_MINUTES,
  );

  await trySendEmail(
    user.email,
    passwordResetEmail({
      name: user.name,
      url: clientUrls.resetPassword(token),
      ttlMinutes: env.RESET_TOKEN_TTL_MINUTES,
    }),
  );
}

export async function resetPassword({ token: rawToken, password }) {
  const claimed = await Token.findOneAndUpdate(
    {
      tokenHash: hashToken(rawToken),
      type: TOKEN_TYPES.PASSWORD_RESET,
      usedAt: null,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    },
    { $set: { usedAt: new Date() } },
    { new: true },
  );

  if (!claimed) {
    throw new ApiError(400, 'This reset link is invalid or has expired');
  }

  const user = await User.findById(claimed.userId);
  if (!user) throw new ApiError(400, 'This reset link is invalid or has expired');

  user.passwordHash = await bcrypt.hash(password, env.BCRYPT_COST);

  // Clicking a link in that inbox proves control of the address, which is the
  // same thing email verification tests. Someone who reset their password
  // through it should not then be asked to verify separately.
  if (user.emailVerifiedAt === null) {
    // Same ordering as verifyEmail, and the same reason. This response carries no
    // balance, so there is nothing to re-read here.
    await grantSignupCredits(user);
    user.emailVerifiedAt = new Date();
  }

  await user.save();

  // Whoever knew the old password is now logged out everywhere. This is the
  // point of a password reset when an account has been compromised.
  await Token.updateMany(
    { userId: user._id, type: TOKEN_TYPES.REFRESH, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );

  logger.info('Password reset', { userId: user._id.toString() });
  return user;
}
