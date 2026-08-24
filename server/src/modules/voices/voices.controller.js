import { getPlanForUser } from '../plans/plans.service.js';

import * as voicesService from './voices.service.js';

export async function listLanguages(req, res) {
  const languages = await voicesService.listLanguages();

  res.status(200).json({ success: true, data: { languages } });
}

/**
 * The voices this caller may use, for the language they asked about.
 *
 * Plan-aware, which is why it is behind auth: the list a user sees has to be the
 * list they can actually generate with, or the voice picker offers choices the
 * generate endpoint then rejects.
 */
export async function listVoices(req, res) {
  const plan = await getPlanForUser(req.user);

  const voices = await voicesService.listVoices({
    // A string, because validate() does not cover query strings - an array or an
    // object here would otherwise reach the filter.
    languageCode: typeof req.query.language === 'string' ? req.query.language : undefined,
    allowedTiers: plan.allowedVoiceTiers,
  });

  res.status(200).json({ success: true, data: { voices } });
}
