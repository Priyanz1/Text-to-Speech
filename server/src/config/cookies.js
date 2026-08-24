import { env, isProduction } from './env.js';

/**
 * Settings for the refresh-token cookie.
 *
 * The refresh token is the long-lived half of the session, so it is kept out of
 * JavaScript's reach entirely: httpOnly means an XSS bug cannot read it.
 */

// Scoped to /api/auth rather than / so the cookie is only ever attached to the
// two routes that need it (refresh and logout). It is not sent along with
// ordinary API calls, which limits where it can leak.
const COOKIE_PATH = '/api/auth';

export const REFRESH_COOKIE_NAME = 'refresh_token';

/**
 * SameSite is the setting most likely to break auth in production, so it is
 * worth being explicit about.
 *
 * Locally the client is http://localhost:5173 and the API is
 * http://localhost:4000. SameSite compares registrable domains and ignores the
 * port, so those count as the *same* site and 'lax' works.
 *
 * In production the client is on vercel.app and the API is on onrender.com -
 * different sites. A 'lax' cookie is not sent on a cross-site fetch, so the
 * browser would silently never send the refresh token and every reload would
 * log the user out. Cross-site therefore requires 'none', which browsers only
 * accept together with Secure.
 *
 * If you later put both behind one domain (app.example.com + api.example.com),
 * set COOKIE_SAMESITE=lax to get SameSite's CSRF protection back.
 */
const sameSite = env.COOKIE_SAMESITE || (isProduction ? 'none' : 'lax');

export const refreshCookieOptions = {
  httpOnly: true,
  // Required by browsers whenever sameSite is 'none', and correct in production
  // regardless. Render terminates TLS, which is why app.js sets trust proxy.
  secure: isProduction || sameSite === 'none',
  sameSite,
  path: COOKIE_PATH,
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1_000,
};

// Clearing a cookie only works if these attributes match the ones it was set
// with, so both objects are derived from the same values.
export const clearRefreshCookieOptions = {
  httpOnly: true,
  secure: refreshCookieOptions.secure,
  sameSite,
  path: COOKIE_PATH,
};
