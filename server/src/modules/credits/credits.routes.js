import { Router } from 'express';

import { requireAuth } from '../../middleware/requireAuth.js';

import * as creditsController from './credits.controller.js';

export const creditsRouter = Router();

// Both read only the caller's own credits - the user id comes from the access
// token, never from the request - so neither takes a user parameter.
creditsRouter.get('/balance', requireAuth, creditsController.getBalance);
creditsRouter.get('/ledger', requireAuth, creditsController.getLedger);
