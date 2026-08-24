import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import mongoose from 'mongoose';

import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import { Token } from '../auth/token.model.js';
import { ORDER_STATUS, PaymentOrder } from '../billing/paymentOrder.model.js';
import { CreditTransaction } from '../credits/creditTransaction.model.js';
import { PLAN_KINDS, Plan } from '../plans/plan.model.js';
import { User } from '../users/user.model.js';
import { Voice } from '../voices/voice.model.js';

/**
 * The admin surface is read-only, and these tests are mostly about the gate.
 *
 * The interesting assertions are not "does the overview render" but "can a normal
 * account reach it" and "does anything here write". An admin endpoint that grants
 * credits is a much bigger hole than an admin endpoint that shows the wrong count,
 * so that is what is checked.
 */
const TEST_DB = 'tts-saas-test-admin';

let dbError = null;
try {
  await mongoose.connect(env.MONGODB_URI, { dbName: TEST_DB, serverSelectionTimeoutMS: 3_000 });
} catch (error) {
  dbError = error.message;
}

const skip = dbError ? `MongoDB is not reachable (${dbError})` : false;

let server;
let baseUrl;

const FREE_PLAN = {
  slug: 'test-free',
  name: 'Test Free',
  kind: PLAN_KINDS.FREE,
  credits: 100,
  maxCharsPerRequest: 200,
  pricePaise: 0,
  allowedVoiceTiers: [],
};

const RETIRED_PACK = {
  slug: 'test-pack-retired',
  name: 'Retired pack',
  kind: PLAN_KINDS.CREDIT_PACK,
  credits: 1_000,
  maxCharsPerRequest: 500,
  pricePaise: 9_900,
  allowedVoiceTiers: [],
  isActive: false,
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
  if (skip) return;

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (skip) return;

  await Promise.all([
    User.deleteMany({}),
    Token.deleteMany({}),
    Plan.deleteMany({}),
    Voice.deleteMany({}),
    CreditTransaction.deleteMany({}),
    PaymentOrder.deleteMany({}),
  ]);
});

after(async () => {
  if (dbError) {
    await mongoose.disconnect().catch(() => {});
    return;
  }

  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();

  if (server) {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
});

// --- helpers ---------------------------------------------------------------

const PASSWORD = 'correct horse battery staple';

async function call(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  return { status: response.status, body: await response.json() };
}

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

/**
 * Signs a user in, optionally promoting them first.
 *
 * The promotion is a direct database write, because that is the only way a user
 * becomes an admin - there is no endpoint for it, deliberately. This test doing it
 * the same awkward way an operator would is the point.
 */
async function signedInUser({ email, admin = false } = {}) {
  const credentials = { name: 'Admin Tester', email, password: PASSWORD };

  const token = await captureEmailedToken(() =>
    call('/api/auth/signup', { method: 'POST', body: credentials }),
  );
  await call('/api/auth/verify-email', { method: 'POST', body: { token } });

  if (admin) {
    await User.updateOne({ email }, { $set: { role: 'admin' } });
  }

  const login = await call('/api/auth/login', { method: 'POST', body: credentials });

  return { accessToken: login.body.data.accessToken, user: login.body.data.user };
}

// --- the gate --------------------------------------------------------------

describe('the /api/admin gate', { skip }, () => {
  it('refuses an anonymous caller with 401', async () => {
    for (const path of ['/overview', '/users', '/plans', '/voices']) {
      const response = await call(`/api/admin${path}`);
      assert.equal(response.status, 401, `${path} was not gated`);
    }
  });

  it('refuses a signed-in non-admin with 403 on every route', async () => {
    await Plan.create(FREE_PLAN);
    const { accessToken } = await signedInUser({ email: 'normal@example.com' });

    for (const path of ['/overview', '/users', '/plans', '/voices']) {
      const response = await call(`/api/admin${path}`, { token: accessToken });

      assert.equal(response.status, 403, `${path} was reachable by a normal account`);
      assert.match(response.body.error.message, /administrator/i);
    }
  });

  it('reads role from the database, not the access token', async () => {
    await Plan.create(FREE_PLAN);
    const { accessToken, user } = await signedInUser({ email: 'promoted@example.com' });

    // Token minted while the account was a normal user.
    assert.equal((await call('/api/admin/overview', { token: accessToken })).status, 403);

    await User.updateOne({ _id: user.id }, { $set: { role: 'admin' } });

    // Same token, now allowed - because requireAuth re-reads the row. The mirror
    // image is what matters in production: a revoked admin loses access at once
    // rather than when their token expires.
    assert.equal((await call('/api/admin/overview', { token: accessToken })).status, 200);
  });
});

// --- the four read endpoints ----------------------------------------------

describe('GET /api/admin/users', { skip }, () => {
  it('lists users with their role, and searches by email', async () => {
    await Plan.create(FREE_PLAN);
    await signedInUser({ email: 'someone@example.com' });
    const admin = await signedInUser({ email: 'boss@example.com', admin: true });

    const all = await call('/api/admin/users', { token: admin.accessToken });

    assert.equal(all.status, 200);
    assert.equal(all.body.data.pagination.total, 2);
    // Fields the public /me response does not carry.
    assert.equal(all.body.data.users.every((row) => typeof row.role === 'string'), true);

    const searched = await call('/api/admin/users?search=someone', { token: admin.accessToken });

    assert.equal(searched.body.data.pagination.total, 1);
    assert.equal(searched.body.data.users[0].email, 'someone@example.com');
  });

  it('treats a regex metacharacter in the search as a literal', async () => {
    await Plan.create(FREE_PLAN);
    const admin = await signedInUser({ email: 'boss@example.com', admin: true });

    // Unescaped, `.*` would match every user. Escaped, it matches none - which is
    // the correct answer, and is also what stops a nested-quantifier pattern
    // pinning a CPU on this endpoint.
    const response = await call('/api/admin/users?search=.*', { token: admin.accessToken });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.pagination.total, 0);
  });

  it('clamps an absurd page size instead of honouring it', async () => {
    await Plan.create(FREE_PLAN);
    const admin = await signedInUser({ email: 'boss@example.com', admin: true });

    const response = await call('/api/admin/users?limit=100000&page=0', {
      token: admin.accessToken,
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.pagination.limit, 100);
    assert.equal(response.body.data.pagination.page, 1);
  });
});

describe('GET /api/admin/plans', { skip }, () => {
  it('includes inactive plans and the operational fields the public route hides', async () => {
    await Plan.create([FREE_PLAN, RETIRED_PACK]);
    const admin = await signedInUser({ email: 'boss@example.com', admin: true });

    const response = await call('/api/admin/plans', { token: admin.accessToken });

    assert.equal(response.status, 200);

    const retired = response.body.data.plans.find((plan) => plan.slug === RETIRED_PACK.slug);

    // The public /api/plans route filters this one out entirely.
    assert.equal(retired.isActive, false);
    // Present as keys even when null: a subscription with no providerPlanId is the
    // most common reason a subscribe button 409s, so it has to be visible.
    assert.equal('providerPlanId' in retired, true);
    assert.equal('creditRenewalPolicy' in retired, true);
    assert.equal('gstIncluded' in retired, true);
  });
});

describe('GET /api/admin/voices', { skip }, () => {
  it('lists voices with provider and active state', async () => {
    await Plan.create(FREE_PLAN);
    await Voice.create([VOICE, { ...VOICE, providerVoiceId: 'en-IN-Wavenet-A', isActive: false }]);
    const admin = await signedInUser({ email: 'boss@example.com', admin: true });

    const response = await call('/api/admin/voices', { token: admin.accessToken });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.pagination.total, 2);
    // Retired voices are listed, so "why can nobody select this voice" has an answer.
    assert.equal(response.body.data.voices.some((voice) => voice.isActive === false), true);
  });
});

describe('GET /api/admin/overview', { skip }, () => {
  it('counts users, revenue and the paid-but-uncredited orders', async () => {
    await Plan.create(FREE_PLAN);
    const admin = await signedInUser({ email: 'boss@example.com', admin: true });

    // One order that was credited, one that was paid and never credited. The second
    // is the only number on this page that describes a user who is out of pocket.
    await PaymentOrder.create([
      {
        userId: admin.user.id,
        planSlug: 'test-pack',
        credits: 1_000,
        amountPaise: 9_900,
        providerOrderId: 'mock_order_credited',
        status: ORDER_STATUS.PAID,
        creditedAt: new Date(),
      },
      {
        userId: admin.user.id,
        planSlug: 'test-pack',
        credits: 1_000,
        amountPaise: 9_900,
        providerOrderId: 'mock_order_stuck',
        status: ORDER_STATUS.PAID,
      },
      {
        userId: admin.user.id,
        planSlug: 'test-pack',
        credits: 1_000,
        amountPaise: 9_900,
        providerOrderId: 'mock_order_unpaid',
        status: ORDER_STATUS.CREATED,
      },
    ]);

    const response = await call('/api/admin/overview', { token: admin.accessToken });

    assert.equal(response.status, 200);

    const { users, payments, subscriptions, credits, generations, webhooks } = response.body.data;

    assert.equal(users.total, 1);
    assert.equal(users.verified, 1);
    assert.equal(users.unverified, 0);

    assert.equal(payments.byStatus.paid, 2);
    assert.equal(payments.byStatus.created, 1);
    // Only paid orders count as revenue, in integer paise.
    assert.equal(payments.revenuePaise, 19_800);
    assert.equal(payments.creditsSold, 2_000);
    assert.equal(payments.paidButUncredited, 1);

    // The signup grant is in the ledger, so the breakdown is not empty.
    assert.equal(credits.byType.signup_grant.credits, FREE_PLAN.credits);

    assert.equal(subscriptions.live, 0);
    assert.equal(generations.total, 0);
    assert.deepEqual(webhooks, []);
  });

  it('changes nothing it reads', async () => {
    await Plan.create(FREE_PLAN);
    const admin = await signedInUser({ email: 'boss@example.com', admin: true });

    const before = await User.findById(admin.user.id).lean();
    const ledgerBefore = await CreditTransaction.countDocuments({});

    await call('/api/admin/overview', { token: admin.accessToken });
    await call('/api/admin/users', { token: admin.accessToken });
    await call('/api/admin/plans', { token: admin.accessToken });
    await call('/api/admin/voices', { token: admin.accessToken });

    const after = await User.findById(admin.user.id).lean();

    // No admin route grants credits, changes a role, or writes anything else. If a
    // write is ever added here, this is the test that should stop it.
    assert.equal(after.subscriptionCredits, before.subscriptionCredits);
    assert.equal(after.purchasedCredits, before.purchasedCredits);
    assert.equal(after.role, before.role);
    assert.equal(await CreditTransaction.countDocuments({}), ledgerBefore);
  });
});
