import { Router } from 'express';

import { requireAuth } from '../../middleware/requireAuth.js';

import * as generationsController from './generations.controller.js';

export const generationsRouter = Router();

/**
 * One user's own history. Every route is behind requireAuth, and every query in
 * the service filters on the id from the access token - so there is no shape of
 * request that reaches another account's generations.
 *
 * The audio itself stays on the tts router (/api/tts/generations/:id/audio),
 * where it was already implemented and already tested. The list here just points
 * at it.
 */
generationsRouter.get('/', requireAuth, generationsController.list);

generationsRouter.get('/:id', requireAuth, generationsController.getOne);

generationsRouter.delete('/:id', requireAuth, generationsController.remove);
