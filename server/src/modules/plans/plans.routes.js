import { Router } from 'express';

import * as plansController from './plans.controller.js';

export const plansRouter = Router();

// No requireAuth. Prices are public information, and the pricing page is a
// signed-out page.
plansRouter.get('/', plansController.listPlans);
