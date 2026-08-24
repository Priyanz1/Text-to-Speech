import { Router } from 'express';

import { requireAdmin } from '../../middleware/requireAdmin.js';
import { requireAuth } from '../../middleware/requireAuth.js';

import * as adminController from './admin.controller.js';

export const adminRouter = Router();

/**
 * requireAuth then requireAdmin on every route, in that order - requireAdmin reads
 * req.user, which requireAuth is what sets.
 *
 * The role is read from the freshly-loaded database row rather than from a token
 * claim, so revoking someone's admin access takes effect on their next request
 * instead of when their access token expires.
 *
 * Read-only by design. See admin.service.js for why there are no write endpoints.
 */
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get('/overview', adminController.getOverview);
adminRouter.get('/users', adminController.listUsers);
adminRouter.get('/plans', adminController.listPlans);
adminRouter.get('/voices', adminController.listVoices);
