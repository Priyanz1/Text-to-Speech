import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { logger } from '../src/config/logger.js';
import * as ttsProvider from '../src/integrations/ttsProvider/index.js';
import { PLAN_KINDS, Plan } from '../src/modules/plans/plan.model.js';
import { Voice } from '../src/modules/voices/voice.model.js';

/**
 * Seeds the two things the application cannot start without: a free plan, and a
 * voice catalog.
 *
 *   npm run seed
 *
 * Safe to run repeatedly. Every write below is an upsert that refreshes only the
 * descriptive fields - the business numbers (a plan's credits and character cap, a
 * voice's tier and cost multiplier) use $setOnInsert, so a value tuned by hand is
 * never clobbered by a re-seed. That property is the whole reason these live in
 * the database instead of in the code.
 */

/**
 * The free plan.
 *
 * The numbers here are PLACEHOLDERS. DECISIONS.md §3 records the free grant size
 * as an open question, and it depends on provider rates that are not calibrated
 * yet. They are here so the application has something to run against, they are
 * $setOnInsert so a real number chosen later survives, and they are not a pricing
 * decision.
 */
const FREE_PLAN = {
  slug: 'free',
  name: 'Free',
  kind: PLAN_KINDS.FREE,
  credits: 5_000, // PLACEHOLDER - 1 credit = 1 character
  maxCharsPerRequest: 2_000, // PLACEHOLDER
  pricePaise: 0,
  // Empty means every tier. Restricting the premium tiers to paid plans is a
  // pricing decision, and pricing is not calibrated yet.
  allowedVoiceTiers: [],
};

/** "en-US" -> "American English". Resolved once here so the client needs no i18n table. */
function languageNameFor(languageCode) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(languageCode) ?? languageCode;
  } catch {
    // A runtime built without full ICU. The code itself is a usable label.
    return languageCode;
  }
}

async function seedPlans() {
  const { slug, ...rest } = FREE_PLAN;

  const result = await Plan.updateOne(
    { slug },
    {
      $set: { name: rest.name, kind: rest.kind, isActive: true },
      $setOnInsert: {
        slug,
        credits: rest.credits,
        maxCharsPerRequest: rest.maxCharsPerRequest,
        pricePaise: rest.pricePaise,
        allowedVoiceTiers: rest.allowedVoiceTiers,
      },
    },
    { upsert: true },
  );

  const plan = await Plan.findOne({ slug });

  logger.info(
    result.upsertedCount > 0
      ? `Created the free plan: ${plan.credits} credits, ${plan.maxCharsPerRequest} chars per request`
      : `Free plan already exists, leaving its numbers alone: ${plan.credits} credits, ${plan.maxCharsPerRequest} chars per request`,
  );

  // Deliberately no paid plans. A seeded price would be a made-up price, and a
  // made-up price in the database is indistinguishable from a real one.
  logger.info('No paid plans seeded - prices are set during the pricing step');
}

async function seedVoices() {
  const voices = await ttsProvider.listVoices();

  if (voices.length === 0) {
    logger.warn('The provider returned no voices; catalog left unchanged');
    return;
  }

  let created = 0;

  for (const voice of voices) {
    const provider = ttsProvider.providerName === 'google' ? 'google' : 'mock';

    const result = await Voice.updateOne(
      { provider, providerVoiceId: voice.providerVoiceId },
      {
        // Descriptive fields: refreshed every run, because the provider owns them.
        $set: {
          languageCode: voice.languageCode,
          languageCodes: voice.languageCodes,
          languageName: languageNameFor(voice.languageCode),
          gender: voice.gender,
          naturalSampleRateHertz: voice.naturalSampleRateHertz,
          isActive: true,
        },
        // Ours: set once, then never touched again. costMultiplier especially -
        // overwriting a calibrated multiplier with the seed default of 1 would
        // silently make every voice cost the base rate.
        $setOnInsert: {
          provider,
          providerVoiceId: voice.providerVoiceId,
          name: voice.providerVoiceId,
          tier: voice.tier,
          costMultiplier: 1,
        },
      },
      { upsert: true },
    );

    if (result.upsertedCount > 0) created += 1;
  }

  // A voice the provider has retired is deactivated rather than deleted, so old
  // Generation records still resolve to something.
  const offered = voices.map((voice) => voice.providerVoiceId);
  const retired = await Voice.updateMany(
    { providerVoiceId: { $nin: offered }, isActive: true },
    { $set: { isActive: false } },
  );

  logger.info(
    `Voice catalog: ${voices.length} offered by ${ttsProvider.providerName}, ${created} new, ${voices.length - created} refreshed, ${retired.modifiedCount} retired`,
  );
}

async function main() {
  await connectDatabase();

  await seedPlans();
  await seedVoices();

  await disconnectDatabase();
}

try {
  await main();
  logger.info('Seed complete');
} catch (error) {
  logger.error('Seed failed', { message: error.message });
  await disconnectDatabase().catch(() => {});
  process.exit(1);
}
