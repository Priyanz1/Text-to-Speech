import { Router } from 'express';

import { authRouter } from '../modules/auth/auth.routes.js';
import { healthRouter } from '../modules/health/health.routes.js';

/**
 * Every API route is mounted here, under the /api prefix.
 * Later phases add: /users, /voices, /tts, /generations, /credits, /plans,
 * /billing, /webhooks, /admin.
 */
export const apiRouter = Router();

// Defines its own paths (/health and /ready) so both sit directly under /api.
apiRouter.use(healthRouter);

// /api/auth is also the path the refresh cookie is scoped to - see config/cookies.js.
apiRouter.use('/auth', authRouter);
