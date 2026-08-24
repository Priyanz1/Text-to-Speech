import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * Per-IP and per-user request limits, counted in this process's memory.
 *
 * In memory, not Redis, deliberately. Redis would make the counters shared
 * across instances and survive a restart, and it would also add a service to
 * run, a connection to manage and a failure mode where the API is down because
 * the rate limiter is. This deployment is a single instance, so a per-process
 * counter IS the global counter. If it ever becomes several instances the limits
 * become per-instance - which is a documented weakening, not a silent one, and
 * the fix is a shared store behind this same function.
 *
 * A restart clears the counters. That is the honest trade: an attacker cannot
 * cause a restart, and a deploy resetting someone's login attempt count is not a
 * meaningful hole.
 *
 * The three limits that matter and why:
 *   auth     - credentials are what is worth brute forcing.
 *   tts      - every generation spends real provider money, so this is a spend
 *              ceiling as much as an abuse one.
 *   payment  - a created order is a row in Razorpay's system too, so a loop here
 *              makes a mess in someone else's dashboard as well as ours.
 */

const WINDOW_MS = env.RATE_LIMIT_WINDOW_MINUTES * 60 * 1_000;

/**
 * How many distinct keys one limiter will track before it stops accepting new
 * ones for the rest of the window.
 *
 * Without a ceiling, a spray of requests from many addresses is a memory leak
 * with extra steps. When the cap is hit, new keys are let through rather than
 * blocked: a limiter that fails closed would turn a burst of unfamiliar traffic
 * into a total outage, which is a worse outcome than briefly not limiting.
 */
const MAX_TRACKED_KEYS = 20_000;

/**
 * Whether limiting is on at all.
 *
 * Off under `node --test`. The suite deliberately fires hundreds of logins from a
 * single address - which is exactly the traffic this middleware exists to refuse -
 * so leaving it on makes unrelated suites fail depending on how many requests ran
 * before them. NODE_TEST_CONTEXT is set by the test runner in every worker, which
 * is a more reliable signal here than NODE_ENV: `npm test` does not set NODE_ENV,
 * and setting it in the script is not portable across shells.
 *
 * A limiter built with `enabled: true` ignores this, which is how the limiter's own
 * behaviour is still tested.
 */
const enabledByDefault = () => env.RATE_LIMIT_ENABLED && !process.env.NODE_TEST_CONTEXT;

/**
 * Builds a limiter.
 *
 * @param name    Appears in the log line and nowhere else.
 * @param max     Requests allowed per key per window.
 * @param keyBy   'ip' or 'user'. 'user' falls back to the IP when the request is
 *                unauthenticated, so an anonymous flood is still bounded.
 * @param paths   Optional. When given, only these paths (relative to where the
 *                limiter is mounted) are counted; anything else passes straight
 *                through. This is how the auth limiter covers /login without also
 *                covering /refresh, which every page load calls legitimately.
 * @param message What the user is told. Never "rate limited" - it should say what
 *                to do next.
 * @param enabled Optional override of the default above. Only tests pass this.
 */
export function rateLimit({ name, max, keyBy = 'ip', paths = null, message, enabled = null }) {
  const hits = new Map();
  const only = paths ? new Set(paths) : null;

  /**
   * Drops expired entries. Unref'd so it never holds the process open - without
   * that, a graceful shutdown would wait on a timer that runs forever.
   */
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, WINDOW_MS);
  sweep.unref();

  return function rateLimiter(req, res, next) {
    if (!(enabled ?? enabledByDefault())) {
      next();
      return;
    }

    if (only && !only.has(req.path)) {
      next();
      return;
    }

    // req.user is set by requireAuth, so a limiter mounted before it only ever
    // sees an IP. That is why the TTS and payment limiters sit after the gate.
    const key =
      keyBy === 'user' && req.user ? `u:${req.user._id.toString()}` : `i:${req.ip ?? 'unknown'}`;

    const now = Date.now();
    let entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      if (!entry && hits.size >= MAX_TRACKED_KEYS) {
        next();
        return;
      }

      entry = { count: 0, resetAt: now + WINDOW_MS };
      hits.set(key, entry);
    }

    entry.count += 1;

    const remaining = Math.max(0, max - entry.count);
    const resetSeconds = Math.ceil((entry.resetAt - now) / 1_000);

    // The draft IETF names, which is what most clients read.
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(resetSeconds));

    if (entry.count > max) {
      res.setHeader('Retry-After', String(resetSeconds));

      // Warn, not error: this is the limiter working. Logged with the limiter's
      // name so a legitimate user hitting a limit that is set too low is
      // findable, because that is the more likely reading of this line.
      logger.warn('Rate limit exceeded', {
        limiter: name,
        key,
        count: entry.count,
        max,
        url: req.originalUrl,
      });

      next(new ApiError(429, message, { retryAfterSeconds: resetSeconds }));
      return;
    }

    next();
  };
}

/**
 * The credential endpoints, per IP.
 *
 * Scoped by path rather than applied to the whole /api/auth router: /refresh runs
 * on every page load and every access-token expiry, and limiting it would log
 * active users out. /me is the same. Neither is a credential guess.
 */
export const authRateLimit = rateLimit({
  name: 'auth',
  max: env.RATE_LIMIT_AUTH_MAX,
  keyBy: 'ip',
  paths: [
    '/login',
    '/signup',
    '/forgot-password',
    '/reset-password',
    '/verify-email',
    '/resend-verification',
  ],
  message: 'Too many attempts from this address. Wait a few minutes and try again.',
});

/** Speech generation, per user. Mounted after requireAuth so the key is the account. */
export const ttsRateLimit = rateLimit({
  name: 'tts',
  max: env.RATE_LIMIT_TTS_MAX,
  keyBy: 'user',
  message: 'You are generating speech faster than this account is allowed to. Try again shortly.',
});

/** Order and subscription creation, per user. */
export const paymentRateLimit = rateLimit({
  name: 'payment',
  max: env.RATE_LIMIT_PAYMENT_MAX,
  keyBy: 'user',
  message: 'Too many payment attempts. Wait a few minutes before trying again.',
});

/**
 * Everything else, per IP, as a backstop.
 *
 * Generous on purpose: a normal session's page loads, polls, refreshes and audio
 * fetches are all counted here, and a limit that catches real use is worse than
 * no limit at all. This is here to stop a script, not to shape traffic.
 *
 * Not applied to the webhook path - see routes/index.js. Razorpay retries from
 * its own addresses and a burst of retries after an outage is exactly when the
 * webhook must not be refused.
 */
export const apiRateLimit = rateLimit({
  name: 'api',
  max: env.RATE_LIMIT_API_MAX,
  keyBy: 'ip',
  message: 'Too many requests from this address. Slow down and try again shortly.',
});
