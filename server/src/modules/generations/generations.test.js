import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import mongoose from 'mongoose';

import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import * as storage from '../../integrations/storage/index.js';
import { Token } from '../auth/token.model.js';
import { CreditTransaction } from '../credits/creditTransaction.model.js';
import { PLAN_KINDS, Plan } from '../plans/plan.model.js';
import { User } from '../users/user.model.js';
import { Voice } from '../voices/voice.model.js';

import { Generation } from './generation.model.js';

/**
 * End-to-end tests for the history endpoints, over real HTTP against a real
 * MongoDB and the mock speech provider.
 *
 * Its own database, for the same reason tts.test.js has one: `node --test` runs
 * test files in parallel processes, so a shared database would have each file's
 * cleanup deleting the other's fixtures.
 */
const TEST_DB = 'tts-saas-test-generations';

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
  name: 'History Tester',
  email: 'history@example.com',
  password: 'correct horse battery staple',
};

async function call(path, { method = 'POST', body, token, raw = false } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (raw) return response;

  return { status: response.status, headers: response.headers, body: await response.json() };
}

/** Same trick as the other suites: the raw token only ever exists in the log. */
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

async function seedCatalog() {
  await Plan.create(PLAN);
  await Voice.create(VOICE);
}

/** Signs up, verifies (which grants the credits), and returns an access token. */
async function signedInUser(email = CREDENTIALS.email) {
  const credentials = { ...CREDENTIALS, email };

  const token = await captureEmailedToken(() => call('/api/auth/signup', { body: credentials }));
  await call('/api/auth/verify-email', { body: { token } });

  const login = await call('/api/auth/login', { body: credentials });

  return { accessToken: login.body.data.accessToken, user: login.body.data.user };
}

/** Generates through the real endpoint, so every row under test is a real one. */
async function generate(accessToken, text) {
  const response = await call('/api/tts', {
    token: accessToken,
    body: { text, voiceId: VOICE.providerVoiceId },
  });

  assert.equal(response.status, 201, `generate failed: ${JSON.stringify(response.body)}`);

  return response.body.data.generation;
}

// --- listing ---------------------------------------------------------------

describe('GET /api/generations', { skip }, () => {
  it("lists the caller's generations newest first, with a preview instead of the full text", async () => {
    await seedCatalog();
    const { accessToken } = await signedInUser();

    await generate(accessToken, 'First one.');
    await generate(accessToken, 'Second one.');

    const response = await call('/api/generations', { method: 'GET', token: accessToken });

    assert.equal(response.status, 200);

    const { generations, total, page, totalPages, hasMore } = response.body.data;

    assert.equal(total, 2);
    assert.equal(page, 1);
    assert.equal(totalPages, 1);
    assert.equal(hasMore, false);

    // Newest first, so the list reads like a history rather than an archive.
    assert.deepEqual(
      generations.map((row) => row.textPreview),
      ['Second one.', 'First one.'],
    );

    const [row] = generations;
    assert.equal(row.textTruncated, false);
    assert.equal(row.text, undefined, 'the list sent the full text');
    assert.equal(row.creditsCharged, 'Second one.'.length);
    assert.equal(row.voice.name, VOICE.name);
    assert.equal(row.voice.languageCode, VOICE.languageCode);
    assert.equal(row.status, 'completed');
    assert.ok(row.createdAt, 'no createdAt');

    // The download/play URL, usable because the audio is still there.
    assert.equal(row.audioUrl, `/api/tts/generations/${row.id}/audio`);
  });

  it('truncates a long preview and flags it', async () => {
    await seedCatalog();
    const { accessToken } = await signedInUser();

    await generate(accessToken, 'x'.repeat(180));

    const response = await call('/api/generations', { method: 'GET', token: accessToken });
    const [row] = response.body.data.generations;

    assert.equal(row.textPreview.length, 160);
    assert.equal(row.textTruncated, true);
  });

  it('paginates, and clamps a limit past the maximum', async () => {
    await seedCatalog();
    const { accessToken } = await signedInUser();

    for (const text of ['one', 'two', 'three']) {
      await generate(accessToken, text);
    }

    const first = await call('/api/generations?page=1&limit=2', { method: 'GET', token: accessToken });

    assert.equal(first.body.data.generations.length, 2);
    assert.equal(first.body.data.total, 3);
    assert.equal(first.body.data.totalPages, 2);
    assert.equal(first.body.data.hasMore, true);
    assert.deepEqual(
      first.body.data.generations.map((row) => row.textPreview),
      ['three', 'two'],
    );

    const second = await call('/api/generations?page=2&limit=2', { method: 'GET', token: accessToken });

    assert.equal(second.body.data.generations.length, 1);
    assert.equal(second.body.data.hasMore, false);
    assert.equal(second.body.data.generations[0].textPreview, 'one');

    // Past the end is an empty page, not an error.
    const past = await call('/api/generations?page=9&limit=2', { method: 'GET', token: accessToken });
    assert.equal(past.status, 200);
    assert.deepEqual(past.body.data.generations, []);

    // An unbounded limit would let one request pull an entire history.
    const huge = await call('/api/generations?limit=5000', { method: 'GET', token: accessToken });
    assert.equal(huge.body.data.limit, 50);

    // Junk falls back to the defaults rather than reaching the query as NaN.
    const junk = await call('/api/generations?page=abc&limit=-4', { method: 'GET', token: accessToken });
    assert.equal(junk.body.data.page, 1);
    assert.equal(junk.body.data.limit, 20);
  });

  it("never lists another user's generations", async () => {
    await seedCatalog();
    const owner = await signedInUser();
    await generate(owner.accessToken, 'Private text.');

    const other = await signedInUser('other@example.com');
    const response = await call('/api/generations', { method: 'GET', token: other.accessToken });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.generations, []);
    assert.equal(response.body.data.total, 0);
  });

  it('requires a signed-in user', async () => {
    assert.equal((await call('/api/generations', { method: 'GET' })).status, 401);
  });
});

// --- one generation --------------------------------------------------------

describe('GET /api/generations/:id', { skip }, () => {
  it('returns the full text', async () => {
    await seedCatalog();
    const { accessToken } = await signedInUser();

    const text = 'y'.repeat(180);
    const created = await generate(accessToken, text);

    const response = await call(`/api/generations/${created.id}`, {
      method: 'GET',
      token: accessToken,
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.generation.text, text);
    assert.equal(response.body.data.generation.charCount, 180);
  });

  it("refuses another user's generation, and does not reveal that it exists", async () => {
    await seedCatalog();
    const owner = await signedInUser();
    const created = await generate(owner.accessToken, 'Private text.');

    const other = await signedInUser('other@example.com');

    const response = await call(`/api/generations/${created.id}`, {
      method: 'GET',
      token: other.accessToken,
    });

    // 404, not 403: a 403 would confirm the id is real.
    assert.equal(response.status, 404);
  });

  it('answers 404 for a malformed id rather than failing to cast it', async () => {
    await seedCatalog();
    const { accessToken } = await signedInUser();

    const response = await call('/api/generations/not-an-object-id', {
      method: 'GET',
      token: accessToken,
    });

    assert.equal(response.status, 404);
  });
});

// --- deleting --------------------------------------------------------------

describe('DELETE /api/generations/:id', { skip }, () => {
  it('removes the record and the audio file', async () => {
    await seedCatalog();
    const { accessToken } = await signedInUser();

    const created = await generate(accessToken, 'Delete me.');
    const storageKey = (await Generation.findById(created.id)).audio.storageKey;

    assert.ok(await storage.get(storageKey), 'the audio was never written');

    const response = await call(`/api/generations/${created.id}`, {
      method: 'DELETE',
      token: accessToken,
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.id, created.id);

    assert.equal(await Generation.countDocuments({}), 0);
    assert.equal(await storage.get(storageKey), null, 'the audio file was left behind');

    // And the audio endpoint stops serving it.
    const audio = await call(created.audioUrl, { method: 'GET', token: accessToken });
    assert.equal(audio.status, 404);
  });

  it('does not refund credits or touch the ledger', async () => {
    await seedCatalog();
    const { accessToken, user } = await signedInUser();

    const text = 'Deleting history is not a refund.';
    const created = await generate(accessToken, text);

    await call(`/api/generations/${created.id}`, { method: 'DELETE', token: accessToken });

    // The charge happened and the audio was delivered; removing the record does
    // not undo either. The ledger keeps its rows so reconcile() still adds up.
    assert.equal((await User.findById(user.id)).subscriptionCredits, PLAN.credits - text.length);
    assert.equal(await CreditTransaction.countDocuments({ type: 'generation_charge' }), 1);
    assert.equal(await CreditTransaction.countDocuments({ type: 'generation_refund' }), 0);
  });

  it("refuses to delete another user's generation, and leaves it intact", async () => {
    await seedCatalog();
    const owner = await signedInUser();
    const created = await generate(owner.accessToken, 'Not yours.');

    const other = await signedInUser('other@example.com');

    const response = await call(`/api/generations/${created.id}`, {
      method: 'DELETE',
      token: other.accessToken,
    });

    assert.equal(response.status, 404);
    assert.equal(await Generation.countDocuments({ _id: created.id }), 1, 'it was deleted anyway');
  });

  it('refuses while a generation is still running, and allows a stale one', async () => {
    await seedCatalog();
    const { accessToken, user } = await signedInUser();

    // A pending row is one the generate path may still be holding: deleting it
    // would break that request's next save, after credits were reserved.
    const pending = await Generation.create({
      userId: user.id,
      text: 'Still going.',
      charCount: 12,
      byteLength: 12,
      voice: { ...VOICE, voiceId: VOICE.providerVoiceId, costMultiplier: 1 },
      creditsCharged: 12,
      status: 'pending',
    });

    const running = await call(`/api/generations/${pending.id}`, {
      method: 'DELETE',
      token: accessToken,
    });

    assert.equal(running.status, 409);
    assert.equal(await Generation.countDocuments({ _id: pending.id }), 1);

    // Older than the grace window it is a leftover from a died-mid-request, and
    // has to be clearable or it stays in the list forever.
    //
    // Through the driver rather than the model: Mongoose treats createdAt as
    // set-on-insert and strips it out of $set, so a Model.updateOne here silently
    // does nothing (`timestamps: false` does not change that).
    await Generation.collection.updateOne(
      { _id: pending._id },
      { $set: { createdAt: new Date(Date.now() - 10 * 60_000) } },
    );

    const stale = await call(`/api/generations/${pending.id}`, {
      method: 'DELETE',
      token: accessToken,
    });

    assert.equal(stale.status, 200);
    assert.equal(await Generation.countDocuments({}), 0);
  });

  it('answers 404 for an already-deleted id, so a repeated delete is not a 500', async () => {
    await seedCatalog();
    const { accessToken } = await signedInUser();

    const created = await generate(accessToken, 'Twice.');

    assert.equal(
      (await call(`/api/generations/${created.id}`, { method: 'DELETE', token: accessToken })).status,
      200,
    );
    assert.equal(
      (await call(`/api/generations/${created.id}`, { method: 'DELETE', token: accessToken })).status,
      404,
    );
  });

  it('requires a signed-in user', async () => {
    await seedCatalog();
    const { accessToken } = await signedInUser();
    const created = await generate(accessToken, 'No token.');

    assert.equal((await call(`/api/generations/${created.id}`, { method: 'DELETE' })).status, 401);
    assert.equal(await Generation.countDocuments({}), 1);
  });
});
