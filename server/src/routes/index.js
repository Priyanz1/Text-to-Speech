import { Router } from 'express';

import { healthRouter } from '../modules/health/health.routes.js';

/**
 * Every API route is mounted here, under the /api prefix.
 * Later phases add: /auth, /users, /voices, /tts, /generations, /credits,
 * /plans, /billing, /webhooks, /admin.
 */
export const apiRouter = Router();

// Defines its own paths (/health and /ready) so both sit directly under /api.
apiRouter.use(healthRouter);
