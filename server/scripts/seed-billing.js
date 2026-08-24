import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { logger } from '../src/config/logger.js';
import { PLAN_KINDS, Plan } from '../src/modules/plans/plan.model.js';

/**
 * Seeds the paid plans, so the billing page has something to show.
 *
 *   npm run seed:billing
 *
 * Kept out of `npm run seed` on purpose. The main seeder refuses to create a
 * priced plan, for a reason worth repeating: a made-up price in the database is
 * indistinguishable from a real one, and the one place that must never be guessed
 * is the number a customer is charged. Running this is therefore a deliberate act,
 * and the log below says out loud that every number it wrote is fake.
 *
 * Every price and credit amount is $setOnInsert, so once you have replaced these
 * with real figures a re-run leaves them alone.
 */

/**
 * PLACEHOLDER PRICES. NONE OF THESE ARE REAL.
 *
 * They are not derived from provider rates, because those are not calibrated (see
 * DECISIONS.md §1 and §3) and because provider pricing changes. The credits-per-
 * rupee ratio below is arbitrary and deliberately round, so that a number nobody
 * has replaced is obvious on sight rather than plausible.
 */
const CREDIT_PACKS = [
  { slug: 'pack-starter', name: 'Starter pack', credits: 50_000, pricePaise: 9_900 },
  { slug: 'pack-standard', name: 'Standard pack', credits: 150_000, pricePaise: 24_900 },
  { slug: 'pack-pro', name: 'Pro pack', credits: 500_000, pricePaise: 74_900 },
];

/**
 * Subscriptions, which cannot be bought until providerPlanId is filled in.
 *
 * That id comes from creating a matching plan in the Razorpay dashboard - Razorpay
 * owns the billing period and the recurring amount, so the plan has to exist there
 * before a subscription can reference it. It is left null here rather than invented,
 * and the catalog reports such a plan as not purchasable instead of offering a
 * button that fails.
 *
 * creditRenewalPolicy is left at the model's default (not_applicable) because
 * DECISIONS.md §2 has not settled reset vs rollover vs partial rollover. Until it
 * does, a charged cycle simply adds its credits - see grantSubscriptionCycle().
 */
const SUBSCRIPTIONS = [
  {
    slug: 'sub-creator',
    name: 'Creator (monthly)',
    credits: 200_000,
    pricePaise: 29_900,
    maxCharsPerRequest: 5_000,
  },
  {
    slug: 'sub-studio',
    name: 'Studio (monthly)',
    credits: 750_000,
    pricePaise: 99_900,
    maxCharsPerRequest: 5_000,
  },
];

/**
 * maxCharsPerRequest is required on every plan document and is written
 * unconditionally, with no "only if it was passed" shortcut.
 *
 * An upsert does not run Mongoose's `required` validators, so omitting the field
 * here does not fail - it quietly writes a plan that the schema forbids, and the
 * catalog then serves an undefined cap to the browser. That is exactly the bug
 * this line prevents.
 */
async function upsertPlan({ slug, name, kind, credits, pricePaise, maxCharsPerRequest }) {
  const result = await Plan.updateOne(
    { slug },
    {
      // Descriptive only. A renamed pack should show its new name; a repriced one
      // must not be silently repriced back by a script.
      $set: { name, kind, isActive: true },
      $setOnInsert: {
        slug,
        credits,
        pricePaise,
        maxCharsPerRequest,
        // Empty means every tier is allowed. Restricting premium voices to premium
        // plans is a pricing decision, and pricing is not calibrated.
        allowedVoiceTiers: [],
      },
    },
    { upsert: true },
  );

  const plan = await Plan.findOne({ slug });

  return { created: result.upsertedCount > 0, plan };
}

async function main() {
  await connectDatabase();

  // A credit pack does not raise your per-request character cap: it adds credits
  // and leaves you on the plan you were already on. The schema still requires the
  // field on every plan, so a pack stores the free plan's cap - a copy of "your
  // cap is unchanged", not a second place where a cap is decided.
  const freePlan = await Plan.findOne({ kind: PLAN_KINDS.FREE });

  if (!freePlan) {
    throw new Error('No free plan exists yet. Run `npm run seed` before `npm run seed:billing`.');
  }

  let created = 0;

  for (const pack of CREDIT_PACKS) {
    const { created: isNew, plan } = await upsertPlan({
      ...pack,
      kind: PLAN_KINDS.CREDIT_PACK,
      maxCharsPerRequest: freePlan.maxCharsPerRequest,
    });
    if (isNew) created += 1;

    logger.info(
      `${isNew ? 'Created' : 'Kept'} credit pack ${plan.slug}: ${plan.credits} credits at ${plan.pricePaise} paise`,
    );
  }

  for (const subscription of SUBSCRIPTIONS) {
    const { created: isNew, plan } = await upsertPlan({
      ...subscription,
      kind: PLAN_KINDS.SUBSCRIPTION,
    });
    if (isNew) created += 1;

    logger.info(
      `${isNew ? 'Created' : 'Kept'} subscription ${plan.slug}: ${plan.credits} credits per cycle at ${plan.pricePaise} paise`,
    );

    if (!plan.providerPlanId) {
      logger.warn(
        `${plan.slug} has no providerPlanId, so it cannot be bought yet. Create the matching plan in the Razorpay dashboard and set it: db.plans.updateOne({slug:"${plan.slug}"},{$set:{providerPlanId:"plan_XXXX"}})`,
      );
    }
  }

  logger.warn(
    `Seeded ${created} new paid plan(s) with PLACEHOLDER prices. Replace every pricePaise and credits value with real figures before taking payments - they are $setOnInsert, so a re-run will not undo your edits.`,
  );

  await disconnectDatabase();
}

try {
  await main();
  logger.info('Billing seed complete');
} catch (error) {
  logger.error('Billing seed failed', { message: error.message });
  await disconnectDatabase().catch(() => {});
  process.exit(1);
}
