import { Router } from 'express';

import { getLiveness, getReadiness } from './health.controller.js';

/**
 * Mounted at /api by src/routes/index.js, giving:
 *   GET /api/health  liveness
 *   GET /api/ready   readiness
 *
 * They are siblings rather than nested because they answer different questions
 * for different consumers - see health.controller.js.
 */
export const healthRouter = Router();

healthRouter.get('/health', getLiveness);
healthRouter.get('/ready', getReadiness);
