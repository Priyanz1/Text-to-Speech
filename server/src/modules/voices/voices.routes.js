import { Router } from 'express';

import { requireAuth } from '../../middleware/requireAuth.js';

import * as voicesController from './voices.controller.js';

export const voicesRouter = Router();

// Both behind auth: the voice list is filtered by the caller's plan, so it needs
// to know who is asking.
voicesRouter.get('/languages', requireAuth, voicesController.listLanguages);
voicesRouter.get('/', requireAuth, voicesController.listVoices);
