import { Router } from 'express';

import { authRateLimit, ttsRateLimit } from '../middleware/rateLimit.js';
import { adminRouter } from '../modules/admin/admin.routes.js';
import { authRouter } from '../modules/auth/auth.routes.js';
import { billingRouter } from '../modules/billing/billing.routes.js';
import { creditsRouter } from '../modules/credits/credits.routes.js';
import { generationsRouter } from '../modules/generations/generations.routes.js';
import { healthRouter } from '../modules/health/health.routes.js';
import { plansRouter } from '../modules/plans/plans.routes.js';
import { ttsRouter } from '../modules/tts/tts.routes.js';
import { voicesRouter } from '../modules/voices/voices.routes.js';

/**
 * Every API route is mounted here, under the /api prefix.
 *
 * With one exception: /api/webhooks is mounted in app.js, above express.json(),
 * because a webhook signature is computed over the raw request bytes and a parsed
 * body has destroyed them. See modules/billing/webhooks.routes.js.
 */
export const apiRouter = Router();

// Defines its own paths (/health and /ready) so both sit directly under /api.
apiRouter.use(healthRouter);

/**
 * /api/auth is also the path the refresh cookie is scoped to - see config/cookies.js.
 *
 * The limiter is path-scoped rather than router-wide, and that matters: /refresh
 * and /me run on every page load, so counting them would sign active users out
 * mid-session. It covers only the endpoints where a high request rate means someone
 * is guessing - login, signup, and the token-bearing flows.
 */
apiRouter.use('/auth', authRateLimit, authRouter);

// Public: the pricing page is a signed-out page.
apiRouter.use('/plans', plansRouter);

apiRouter.use('/voices', voicesRouter);
apiRouter.use('/credits', creditsRouter);

/**
 * Per-user, because TTS costs real money per request. Applied here rather than
 * inside tts.routes.js so the already-tested route file is untouched.
 *
 * The credit balance is the real spending limit; this stops one account burning a
 * month's credits in a loop before anyone notices.
 */
apiRouter.use('/tts', ttsRateLimit, ttsRouter);

// History. The audio bytes stay under /tts, where the generate path put them.
apiRouter.use('/generations', generationsRouter);

// Money. Per-route rate limiting lives inside, on the routes that call the provider.
apiRouter.use('/billing', billingRouter);

// Read-only, and behind requireAuth + requireAdmin on every route.
apiRouter.use('/admin', adminRouter);
