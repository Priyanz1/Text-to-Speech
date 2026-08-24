import crypto from 'node:crypto';

import jwt from 'jsonwebtoken';

import { env } from '../../config/env.js';

// Pinning both claims means a token minted for something else - another service
// sharing the secret, a future admin API - is rejected here rather than quietly
// accepted. jwt.verify checks them for us when they are passed on both sides.
const ISSUER = 'tts-saas';
const AUDIENCE = 'tts-saas-api';

/**
 * Mints the short-lived access token the browser sends as a Bearer header.
 *
 * `role` is embedded so an authorization check does not need a database read.
 * The tradeoff is that a role change only takes effect when the access token
 * next rotates, which is at most ACCESS_TOKEN_TTL away.
 */
export function signAccessToken(user) {
  return jwt.sign({ role: user.role }, env.JWT_SECRET, {
    subject: user._id.toString(),
    expiresIn: env.ACCESS_TOKEN_TTL,
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithm: 'HS256',
  });
}

/**
 * Returns the token's payload, or throws if it is expired, tampered with, or
 * not one of ours.
 *
 * Passing `algorithms` is not optional. Without it a caller can choose the
 * algorithm by putting it in the token header, which is the root of the classic
 * "alg: none" and RS256-verified-as-HS256 forgeries.
 */
export function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_SECRET, {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ['HS256'],
  });
}

/**
 * A single-use secret to put in a URL or a cookie: 32 random bytes, and the
 * SHA-256 hash we store instead of the value itself.
 *
 * SHA-256 rather than bcrypt is deliberate. bcrypt is slow on purpose to make
 * guessing a low-entropy *password* expensive; there is nothing to guess about
 * 256 random bits. And because SHA-256 is deterministic we can find a token by
 * its hash with an indexed lookup, which bcrypt's per-hash salt would make
 * impossible without scanning every row.
 */
export function createOpaqueToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function minutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60 * 1_000);
}

export function daysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1_000);
}
