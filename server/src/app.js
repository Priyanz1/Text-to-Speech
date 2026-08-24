import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { corsOptions } from './config/cors.js';
import { env } from './config/env.js';
import { requestLogger } from './middleware/requestLogger.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';
import { apiRateLimit } from './middleware/rateLimit.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { webhooksRouter } from './modules/billing/webhooks.routes.js';
import { apiRouter } from './routes/index.js';

/**
 * Builds the Express application without starting it.
 *
 * Keeping "build the app" separate from "listen on a port" (src/index.js) means
 * tests can create an app instance without binding a port or opening sockets.
 *
 * Middleware order matters and reads top to bottom:
 *   security headers -> CORS -> webhooks (raw body) -> JSON -> cookies ->
 *   logging -> rate limit -> routes -> 404 -> errors
 */
export function createApp() {
  const app = express();

  // Do not advertise the framework in response headers.
  app.disable('x-powered-by');

  // Render terminates TLS and forwards to us over HTTP, so without this
  // req.ip is the proxy's address (making per-IP rate limiting useless) and
  // req.protocol is "http" (which would break Secure cookies). The value is
  // the number of proxies in front of us: Render is 1.
  app.set('trust proxy', 1);

  // First, so even a 404 or a CORS refusal carries them. See middleware/securityHeaders.js.
  app.use(securityHeaders);

  // Which browser origins may call this API. See config/cors.js.
  app.use(cors(corsOptions));

  /**
   * Before express.json(), and that order is the whole reason this is mounted
   * here rather than inside apiRouter.
   *
   * A webhook signature is an HMAC over the exact bytes Razorpay sent. Once
   * express.json() has parsed the body those bytes are unrecoverable, so the raw
   * parser on this router has to see the request first. Everything else still
   * gets JSON, because express.raw() only matches this one path.
   */
  app.use('/api/webhooks', webhooksRouter);

  /**
   * Cap the body size. Configurable, defaulting to 100kb, because the biggest
   * legitimate request is a TTS payload at TTS_MAX_INPUT_BYTES - a few kilobytes -
   * and a limit sized for that is a limit an attacker cannot use to exhaust
   * memory. A 413 from here is deliberate.
   */
  app.use(express.json({ limit: env.JSON_BODY_LIMIT }));

  // Populates req.cookies. Only the refresh token lives in a cookie, and only
  // /api/auth ever receives it - see config/cookies.js.
  app.use(cookieParser());

  app.use(requestLogger);

  /**
   * A per-IP ceiling on everything below. Generous by design: it is a backstop
   * against a runaway client or a crude flood, not the real defence. The tight
   * limits are on /auth, /tts and /billing, applied at their mount points.
   *
   * Below the webhook mount on purpose - Razorpay retries from its own addresses,
   * and a burst of retries after an outage is exactly when the webhook must not be
   * refused.
   */
  app.use('/api', apiRateLimit);

  app.use('/api', apiRouter);

  // Must be the last two, in this order.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
