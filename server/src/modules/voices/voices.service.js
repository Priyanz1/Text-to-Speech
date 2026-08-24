import { Voice } from './voice.model.js';

/**
 * Reads of the voice catalog. The catalog is seeded from the provider and then
 * owned by us - see scripts/seed.js.
 */

/**
 * The languages that have at least one active voice, with a count.
 *
 * Built from the catalog rather than from a fixed list, so a language appears in
 * the picker exactly when there is something in it to pick.
 */
export async function listLanguages() {
  const rows = await Voice.aggregate([
    { $match: { isActive: true } },
    {
      $group: {
        _id: '$languageCode',
        // $first over a sorted group would need a sort stage; the name is the
        // same for every voice in a locale, so any of them will do.
        languageName: { $first: '$languageName' },
        voiceCount: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  return rows.map((row) => ({
    languageCode: row._id,
    languageName: row.languageName || row._id,
    voiceCount: row.voiceCount,
  }));
}

/**
 * Active voices, optionally for one language and optionally filtered to the
 * tiers a plan allows.
 *
 * An empty allowedVoiceTiers means "all tiers", which is what the free plan
 * ships with - restricting the premium tiers is a pricing decision, and pricing
 * is not calibrated yet (DECISIONS.md §1).
 */
export async function listVoices({ languageCode, allowedTiers = [] } = {}) {
  const filter = { isActive: true };

  if (languageCode) filter.languageCode = languageCode;
  if (allowedTiers.length > 0) filter.tier = { $in: allowedTiers };

  const voices = await Voice.find(filter).sort({ languageCode: 1, tier: 1, name: 1 });

  return voices.map((voice) => voice.toPublicJSON());
}

/**
 * One active voice by its provider id.
 *
 * Returns the document rather than the public shape: the caller needs
 * costMultiplier for the quote and the whole record for the Generation snapshot.
 */
export function findActiveByVoiceId(voiceId) {
  return Voice.findOne({ providerVoiceId: voiceId, isActive: true });
}
