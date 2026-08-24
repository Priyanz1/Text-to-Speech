import { Router } from 'express';

import { authRouter } from '../modules/auth/auth.routes.js';
import { creditsRouter } from '../modules/credits/credits.routes.js';
import { generationsRouter } from '../modules/generations/generations.routes.js';
import { healthRouter } from '../modules/health/health.routes.js';
import { plansRouter } from '../modules/plans/plans.routes.js';
import { ttsRouter } from '../modules/tts/tts.routes.js';
import { voicesRouter } from '../modules/voices/voices.routes.js';

/**
 * Every API route is mounted here, under the /api prefix.
 * Later phases add: /users, /billing, /webhooks, /admin.
 */
export const apiRouter = Router();

// Defines its own paths (/health and /ready) so both sit directly under /api.
apiRouter.use(healthRouter);

// /api/auth is also the path the refresh cookie is scoped to - see config/cookies.js.
apiRouter.use('/auth', authRouter);

// Public: the pricing page is a signed-out page.
apiRouter.use('/plans', plansRouter);

apiRouter.use('/voices', voicesRouter);
apiRouter.use('/credits', creditsRouter);
apiRouter.use('/tts', ttsRouter);

// History. The audio bytes stay under /tts, where the generate path put them.
apiRouter.use('/generations', generationsRouter);
