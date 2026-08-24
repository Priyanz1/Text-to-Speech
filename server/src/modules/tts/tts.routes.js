import { Router } from 'express';

import { requireAuth } from '../../middleware/requireAuth.js';
import { validate } from '../../middleware/validate.js';

import * as ttsController from './tts.controller.js';
import { generateSchema } from './tts.validation.js';

export const ttsRouter = Router();

// Every route here spends or reads something that belongs to one account, so
// requireAuth is on all of them.
ttsRouter.get('/config', requireAuth, ttsController.getConfig);

ttsRouter.post('/', requireAuth, validate(generateSchema), ttsController.generate);

// Ownership is enforced in the service by querying on userId, not by comparing
// after the fetch.
ttsRouter.get('/generations/:id/audio', requireAuth, ttsController.getAudio);
