import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Which browser origins may call this API.
 *
 * In development this is one origin (the Vite dev server). In production it is
 * the deployed frontend, plus optionally the Vercel preview URLs, which change
 * per branch and so cannot be hard-coded.
 *
 * Note that CORS protects *browsers*, not the API. curl and server-to-server
 * calls ignore these headers entirely, which is why an origin being blocked
 * here is not a security boundary - it is a browser courtesy. Real
 * authorisation arrives in Phase 2.
 */
const allowedOrigins = new Set([env.CLIENT_URL, ...env.CORS_EXTRA_ORIGINS]);

logger.info('CORS allowlist', { origins: [...allowedOrigins] });

export const corsOptions = {
  origin(origin, callback) {
    // No Origin header at all: curl, Render's health check probe, or a
    // same-origin navigation. There is nothing for CORS to decide.
    if (!origin) {
      callback(null, true);
      return;
    }

    if (allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }

    // Refuse by *omitting* the Access-Control-Allow-Origin header rather than
    // passing an error to the callback. Passing an error would surface as a
    // 500 in our logs and metrics, when in fact nothing on the server failed -
    // the browser simply will not be allowed to read the response.
    logger.warn('Blocked cross-origin request', { origin });
    callback(null, false);
  },

  // Required for the httpOnly refresh-token cookie in Phase 2. Note that a
  // wildcard origin is illegal alongside credentials, so the explicit
  // allowlist above is not optional once cookies are in play.
  credentials: true,

  // Let browsers cache the preflight result instead of re-asking before every
  // non-simple request. Browsers cap this themselves (Chrome at 2 hours).
  maxAge: 86_400,
};
