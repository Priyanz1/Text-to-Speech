import { Router } from 'express';

import { getHealth } from './health.controller.js';

export const healthRouter = Router();

// Mounted at /api/health by src/routes/index.js
healthRouter.get('/', getHealth);
