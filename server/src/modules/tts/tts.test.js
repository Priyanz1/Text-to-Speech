import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import mongoose from 'mongoose';

import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import * as storage from '../../integrations/storage/index.js';
import { CreditTransaction } from '../credits/creditTransaction.model.js';
import * as creditsService from '../credits/credits.service.js';
import { Generation } from '../generations/generation.model.js';
import { PLAN_KINDS, Plan } from '../plans/plan.model.js';
import { Token } from '../auth/token.model.js';
import { User } from '../users/user.model.js';
import { Voice } from '../voices/voice.model.js';

/**
 * End-to-end tests for the credit path and the generate endpoint, over real HTTP
 * against a real MongoDB and the mock speech provider.
 *
 * Same harness as auth.test.js: a separate database, and a visible skip rather
 * than a failure when MongoDB is not running. A different database name from that
 * file on purpose - `node --test` runs test files in parallel processes, so a
 * shared one would have each file's cleanup deleting the other's fixtures.
 *
 * The mock provider is what makes these tests possible without a billing
 * account, and it is not a stub of the code under test - the reserve, the
 * refund, the storage round trip and the audio response are all the real ones.
 */
const TEST_DB = 'tts-saas-test-tts';

let dbError = null;
try {
  await mongoose.connect(env.MONGODB_URI, { dbName: TEST_DB, serverSelectionTimeoutMS: 3_000 });
} catch (error) {
  dbError = error.message;
}

const skip = dbError ? `MongoDB is not reachable (${dbError})` : false;

let server;
let baseUrl;

const PLAN = {
  slug: 'test-free',
  name: 'Test Free',
  kind: PLAN_KINDS.FREE,
  credits: 500,
  maxCharsPerRequest: 200,
  pricePaise: 0,
  allowedVoiceTiers: [],
};

const VOICE = {
  provider: 'mock',
  providerVoiceId: 'en-US-Neural2-F',
  name: 'en-US-Neural2-F',
  languageCode: 'en-US',
  languageCodes: ['en-US'],
  languageName: 'American English',
  gender: 'FEMALE',
  tier: 'neural2',
  costMultiplier: 1,
};

before(async () => {
  if (dbError) return;

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (dbError) return;

  // Delete the audio these tests wrote, so a test run leaves nothing behind.
  const generations = await Generation.find({}).lean();
  await Promise.all(
    generations.filter((g) => g.audio?.storageKey).map((g) => storage.remove(g.audio.storageKey)),
  );

  await Promise.all([
    User.deleteMany({}),
    Token.deleteMany({}),
    Plan.deleteMany({}),
    Voice.deleteMany({}),
    Generation.deleteMany({}),
    CreditTransaction.deleteMany({}),
  ]);
});

after(async () => {
  if (dbError) {
    await mongoose.disconnect().catch(() => {});
    return;
  }

  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();

  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await closed;
});

// --- helpers ---------------------------------------------------------------

const CREDENTIALS = {
  name: 'Credit Tester',
  email: 'credits@example.com',
  password: 'correct horse battery staple',
};

async function call(path, { method = 'POST', body, token, raw = false } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    // Spread rather than `body: undefined`, so a GET carries no body key at all.
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (raw) return response;

  return { status: response.status, headers: response.headers, body: await response.json() };
}

/** Same trick as auth.test.js: the raw token only ever exists in the log. */
async function captureEmailedToken(fn) {
  const original = process.stdout.write.bind(process.stdout);
  let captured = '';

  process.stdout.write = (chunk, ...rest) => {
    captured += chunk;
    return original(chunk, ...rest);
  };

  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }

  return captured.match(/token=([A-Za-z0-9_-]{20,})/)?.[1] ?? null;
}

async function seedCatalog(overrides = {}) {
  await Plan.create({ ...PLAN, ...overrides.plan });
  await Voice.create({ ...VOICE, ...overrides.voice });
}

/** Signs up, verifies (which grants the credits), and returns an access token. */
async function signedInUser() {
  const token = await captureEmailedToken(() =>
    call('/api/auth/signup', { body: CREDENTIALS }),
  );
  await call('/api/auth/verify-email', { body: { token } });

  const login = await call('/api/auth/login', { body: CREDENTIALS });

  return { accessToken: login.body.data.accessToken, user: login.body.data.user };
}

// --- the signup grant ------------------------------------------------------

describe('free credits on verification', { skip }, () => {
  it('grants the free plan credits and writes one ledger row', async () => {
    await seedCatalog();

    const token = await captureEmailedToken(() => call('/api/auth/signup', { body: CREDENTIALS }));

    // Not before verifying: an unconfirmed address is a free-credit faucet.
    assert.equal((await User.findOne({})).subscriptionCredits, 0);

    const verify = await call('/api/auth/verify-email', { body: { token } });

    assert.equal(verify.status, 200);
    assert.equal(verify.body.data.user.credits.total, PLAN.credits);

    const rows = await CreditTransaction.find({});
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'signup_grant');
    assert.equal(rows[0].amount, PLAN.credits);
    assert.equal(rows[0].balanceAfter, PLAN.credits);
  });

  it('does not grant twice', async () => {
    await seedCatalog();
    const { user } = await signedInUser();

    // Verification is single-use, so the second grant has to be driven directly.
    const granted = await creditsService.grantSignupCredits(await User.findById(user.id));

    assert.equal(granted, 0);
    assert.equal((await User.findById(user.id)).subscriptionCredits, PLAN.credits);
    assert.equal(await CreditTransaction.countDocuments({ type: 'signup_grant' }), 1);
  });
});

// --- generation ------------------------------------------------------------

describe('POST /api/tts', { skip }, () => {
  it('charges by character, stores audio, and returns the new balance', async () => {
    await seedCatalog();
    const { accessToken, user } = await signedInUser();

    const text = 'Hello from the test suite.';
    const response = await call('/api/tts', {
      token: accessToken,
      body: { text, voiceId: VOICE.providerVoiceId },
    });

    assert.equal(response.status, 201);

    const { generation, credits } = response.body.data;
    assert.equal(generation.status, 'completed');
    assert.equal(generation.charCount, text.length);
    assert.equal(generation.creditsCharged, text.length);
    assert.ok(generation.audioUrl, 'no audio url');

    // The balance in the response is what the widget renders, so it has to be
    // the post-charge number and not the one from login.
    assert.equal(credits.total, PLAN.credits - text.length);
    assert.equal((await User.findById(user.id)).subscriptionCredits, PLAN.credits - text.length);

    // One ledger row, in the subscription bucket, negative.
    const charges = await CreditTransaction.find({ type: 'generation_charge' });
    assert.equal(charges.length, 1);
    assert.equal(charges[0].bucket, 'subscription');
    assert.equal(charges[0].amount, -text.length);
  });

  it('counts bytes and characters separately for non-ASCII text', async () => {
    await seedCatalog();
    const { accessToken } = await signedInUser();

    const text = 'café';
    const response = await call('/api/tts', {
      token: accessToken,
      body: { text, voiceId: VOICE.providerVoiceId },
    });

    // Charged per character, limited per byte. Charging by bytes would mean a
    // Hindi user pays three times what an English user pays for one sentence.
    assert.equal(response.body.data.generation.charCount, 4);
    assert.equal(response.body.data.generation.byteLength, 5);
    assert.equal(response.body.data.generation.creditsCharged, 4);
  });

  it('spends subscription credits before purchased ones', async () => {
    await seedCatalog();
    const { accessToken, user } = await signedInUser();

    // 10 subscription, 100 purchased. A 30-credit charge must drain the 10 and
    // take 20 from purchased, not the other way round - purchased credits do not
    // expire, so spending them first would burn the ones worth keeping.
    await User.updateOne(
      { _id: user.id },
      { $set: { subscriptionCredits: 10, purchasedCredits: 100 } },
    );

    const response = await call('/api/tts', {
      token: accessToken,
      body: { text: 'a'.repeat(30), voiceId: VOICE.providerVoiceId },
    });

    assert.equal(response.status, 201);

    const after = await User.findById(user.id);
    assert.equal(after.subscriptionCredits, 0);
    assert.equal(after.purchasedCredits, 80);

    // And the split is recorded, so a refund can put it back where it came from.
    const generation = await Generation.findById(response.body.data.generation.id);
    assert.equal(generation.creditSplit.subscription, 10);
    assert.equal(generation.creditSplit.purchased, 20);
  });

  it('refuses when the balance is short, and charges nothing', async () => {
    await seedCatalog();
    const { accessToken, user } = await signedInUser();

    await User.updateOne({ _id: user.id }, { $set: { subscriptionCredits: 5, purchasedCredits: 0 } });

    const response = await call('/api/tts', {
      token: accessToken,
      body: { text: 'a'.repeat(50), voiceId: VOICE.providerVoiceId },
    });

    assert.equal(response.status, 402);

    const after = await User.findById(user.id);
    assert.equal(after.subscriptionCredits, 5, 'credits moved on a refused generation');
    assert.equal(await CreditTransaction.countDocuments({ type: 'generation_charge' }), 0);

    // The row exists and says why, rather than silently disappearing.
    assert.equal((await Generation.findOne({})).status, 'failed');
  });

  it('refunds to the original buckets', async () => {
    await seedCatalog();
    const { accessToken, user } = await signedInUser();

    await User.updateOne(
      { _id: user.id },
      { $set: { subscriptionCredits: 10, purchasedCredits: 100 } },
    );

    // Charge across both buckets, then run the refund the provider-failure path
    // runs. Driving refund() directly rather than forcing the mock provider to
    // throw keeps the test about the credit movement, which is the part that has
    // to be exactly right.
    const charged = await call('/api/tts', {
      token: accessToken,
      body: { text: 'a'.repeat(30), voiceId: VOICE.providerVoiceId },
    });

    const generation = await Generation.findById(charged.body.data.generation.id);
    const refunded = await creditsService.refund({ generation, note: 'test' });

    assert.equal(refunded, 30);

    const after = await User.findById(user.id);
    assert.equal(after.subscriptionCredits, 10, 'subscription credits were not restored');
    assert.equal(after.purchasedCredits, 100, 'purchased credits were not restored');

    // Two rows, one per bucket, both positive.
    const refunds = await CreditTransaction.find({ type: 'generation_refund' }).sort({ bucket: 1 });
    assert.equal(refunds.length, 2);
    assert.deepEqual(
      refunds.map((row) => [row.bucket, row.amount]),
      [
        ['purchased', 20],
        ['subscription', 10],
      ],
    );

    // And a second refund is a no-op rather than free credits.
    assert.equal(await creditsService.refund({ generation: await Generation.findById(generation._id) }), 0);
    assert.equal((await User.findById(user.id)).purchasedCredits, 100);
  });

  it('charges once for a repeated idempotency key', async () => {
    await seedCatalog();
    const { accessToken, user } = await signedInUser();

    const body = {
      text: 'Double clicked.',
      voiceId: VOICE.providerVoiceId,
      idempotencyKey: 'test-key-0123456789',
    };

    const first = await call('/api/tts', { token: accessToken, body });
    const second = await call('/api/tts', { token: accessToken, body });

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(second.body.data.generation.id, first.body.data.generation.id);

    assert.equal(await Generation.countDocuments({}), 1);
    assert.equal(
      (await User.findById(user.id)).subscriptionCredits,
      PLAN.credits - body.text.length,
      'a retry charged twice',
    );
  });

  it('rejects text past the provider byte limit before charging', async () => {
    await seedCatalog({ plan: { maxCharsPerRequest: 100_000 } });
    const { accessToken, user } = await signedInUser();

    const response = await call('/api/tts', {
      token: accessToken,
      body: { text: 'a'.repeat(env.TTS_MAX_INPUT_BYTES + 1), voiceId: VOICE.providerVoiceId },
    });

    assert.equal(response.status, 400);
    // Rejected by the validator, so nothing was written and nothing was spent.
    assert.equal(await Generation.countDocuments({}), 0);
    assert.equal((await User.findById(user.id)).subscriptionCredits, PLAN.credits);
  });

  it("rejects text past the plan's character cap", async () => {
    await seedCatalog();
    const { accessToken } = await signedInUser();

    const response = await call('/api/tts', {
      token: accessToken,
      body: { text: 'a'.repeat(PLAN.maxCharsPerRequest + 1), voiceId: VOICE.providerVoiceId },
    });

    assert.equal(response.status, 400);
    assert.equal(await Generation.countDocuments({}), 0);
  });

  it('rejects an unknown voice', async () => {
    await seedCatalog();
    const { accessToken } = await signedInUser();

    const response = await call('/api/tts', {
      token: accessToken,
      body: { text: 'Hello.', voiceId: 'xx-XX-Nonexistent-A' },
    });

    assert.equal(response.status, 404);
  });

  it('requires a signed-in user', async () => {
    await seedCatalog();

    const response = await call('/api/tts', {
      body: { text: 'Hello.', voiceId: VOICE.providerVoiceId },
    });

    assert.equal(response.status, 401);
  });
});

// --- audio -----------------------------------------------------------------

describe('GET /api/tts/generations/:id/audio', { skip }, () => {
  it('returns playable audio to the owner', async () => {
    await seedCatalog();
    const { accessToken } = await signedInUser();

    const created = await call('/api/tts', {
      token: accessToken,
      body: { text: 'Play me back.', voiceId: VOICE.providerVoiceId },
    });

    const response = await call(created.body.data.generation.audioUrl, {
      method: 'GET',
      token: accessToken,
      raw: true,
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/wav');

    const buffer = Buffer.from(await response.arrayBuffer());
    assert.ok(buffer.byteLength > 44, 'no audio data');
    // A real RIFF/WAVE header, so the browser's player has something to play.
    assert.equal(buffer.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(buffer.subarray(8, 12).toString('ascii'), 'WAVE');
  });

  it("refuses another user's audio, and does not reveal that it exists", async () => {
    await seedCatalog();
    const owner = await signedInUser();

    const created = await call('/api/tts', {
      token: owner.accessToken,
      body: { text: 'Private.', voiceId: VOICE.providerVoiceId },
    });

    // A second account.
    const otherToken = await captureEmailedToken(() =>
      call('/api/auth/signup', { body: { ...CREDENTIALS, email: 'other@example.com' } }),
    );
    await call('/api/auth/verify-email', { body: { token: otherToken } });
    const otherLogin = await call('/api/auth/login', {
      body: { ...CREDENTIALS, email: 'other@example.com' },
    });

    const response = await call(created.body.data.generation.audioUrl, {
      method: 'GET',
      token: otherLogin.body.data.accessToken,
    });

    // 404, not 403: a 403 would confirm the id is real.
    assert.equal(response.status, 404);
  });

  it('refuses an unauthenticated request', async () => {
    await seedCatalog();
    const { accessToken } = await signedInUser();

    const created = await call('/api/tts', {
      token: accessToken,
      body: { text: 'No token.', voiceId: VOICE.providerVoiceId },
    });

    assert.equal((await call(created.body.data.generation.audioUrl, { method: 'GET' })).status, 401);
  });
});

// --- catalog and balance ---------------------------------------------------

describe('catalog and balance endpoints', { skip }, () => {
  it('lists languages and voices for a signed-in user', async () => {
    await seedCatalog();
    const { accessToken } = await signedInUser();

    const languages = await call('/api/voices/languages', { method: 'GET', token: accessToken });
    assert.equal(languages.status, 200);
    assert.deepEqual(languages.body.data.languages, [
      { languageCode: 'en-US', languageName: 'American English', voiceCount: 1 },
    ]);

    const voices = await call('/api/voices?language=en-US', { method: 'GET', token: accessToken });
    assert.equal(voices.status, 200);
    assert.equal(voices.body.data.voices.length, 1);
    assert.equal(voices.body.data.voices[0].voiceId, VOICE.providerVoiceId);
  });

  it('hides tiers the plan does not allow', async () => {
    await seedCatalog({ plan: { allowedVoiceTiers: ['standard'] } });
    const { accessToken } = await signedInUser();

    const voices = await call('/api/voices', { method: 'GET', token: accessToken });
    assert.equal(voices.body.data.voices.length, 0);

    // And the generate endpoint agrees, rather than trusting the filtered list.
    const response = await call('/api/tts', {
      token: accessToken,
      body: { text: 'Hello.', voiceId: VOICE.providerVoiceId },
    });
    assert.equal(response.status, 403);
  });

  it('reports the balance and the ledger', async () => {
    await seedCatalog();
    const { accessToken } = await signedInUser();

    const balance = await call('/api/credits/balance', { method: 'GET', token: accessToken });
    assert.equal(balance.body.data.credits.total, PLAN.credits);

    const ledger = await call('/api/credits/ledger', { method: 'GET', token: accessToken });
    assert.equal(ledger.body.data.entries.length, 1);
    assert.equal(ledger.body.data.entries[0].type, 'signup_grant');
  });

  it("reports the plan's limits so the form can enforce them", async () => {
    await seedCatalog();
    const { accessToken } = await signedInUser();

    const config = await call('/api/tts/config', { method: 'GET', token: accessToken });

    assert.equal(config.body.data.config.maxCharsPerRequest, PLAN.maxCharsPerRequest);
    assert.equal(config.body.data.config.maxInputBytes, env.TTS_MAX_INPUT_BYTES);
  });

  it('keeps the cached balance and the ledger in agreement', async () => {
    await seedCatalog();
    const { accessToken, user } = await signedInUser();

    await call('/api/tts', {
      token: accessToken,
      body: { text: 'Reconcile me.', voiceId: VOICE.providerVoiceId },
    });

    const result = await creditsService.reconcile(user.id);

    assert.equal(result.ok, true, JSON.stringify(result));
  });
});
