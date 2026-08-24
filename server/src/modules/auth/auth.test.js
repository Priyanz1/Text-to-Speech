import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import mongoose from 'mongoose';

import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import { REFRESH_COOKIE_NAME } from '../../config/cookies.js';
import { User } from '../users/user.model.js';
import { TOKEN_TYPES, Token } from './token.model.js';

/**
 * End-to-end tests for the auth routes, over real HTTP against a real MongoDB.
 *
 * They use a separate database (tts-saas-test-auth) so they cannot touch
 * development data, and they skip themselves with a visible reason if MongoDB is
 * not running rather than failing - `npm test` stays useful without a database,
 * and the health tests next door need no database at all.
 *
 * One database per test FILE, not one shared test database: `node --test` runs
 * files in parallel processes, so a shared database means one file's afterEach
 * cleanup deletes another file's fixtures mid-test.
 *
 * Connecting here at the top level, before any describe() runs, is what lets the
 * skip reason be decided in time.
 */
const TEST_DB = 'tts-saas-test-auth';

let dbError = null;
try {
  await mongoose.connect(env.MONGODB_URI, {
    dbName: TEST_DB,
    serverSelectionTimeoutMS: 3_000,
  });
} catch (error) {
  dbError = error.message;
}

const skip = dbError ? `MongoDB is not reachable (${dbError})` : false;

let server;
let baseUrl;

before(async () => {
  if (dbError) return;

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

// Every test starts from an empty database, so none of them depend on the order
// they run in.
afterEach(async () => {
  if (dbError) return;
  await Promise.all([User.deleteMany({}), Token.deleteMany({})]);
});

after(async () => {
  if (dbError) {
    await mongoose.disconnect().catch(() => {});
    return;
  }

  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();

  // fetch holds sockets open, and close() waits for all of them.
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await closed;
});

// --- helpers ---------------------------------------------------------------

const CREDENTIALS = {
  name: 'Test User',
  email: 'test@example.com',
  password: 'correct horse battery staple',
};

async function call(path, { method = 'POST', body, token, cookie } = {}) {
  const response = await fetch(`${baseUrl}/api/auth${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: `${REFRESH_COOKIE_NAME}=${cookie}` } : {}),
    },
    // Spread rather than `body: undefined`, so a GET carries no body key at all.
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  return { status: response.status, headers: response.headers, body: await response.json() };
}

/** Pulls the refresh token out of the Set-Cookie header. */
function refreshCookieFrom(response) {
  const header = response.headers.getSetCookie().find((c) => c.startsWith(REFRESH_COOKIE_NAME));
  return { raw: header, value: header?.split(';')[0].split('=')[1] };
}

/**
 * Runs `fn` while capturing stdout, and returns any token found in a link.
 *
 * With EMAIL_PROVIDER=log the verification and reset links are written to the
 * log, which is the only place the raw token ever appears - the database stores
 * just its hash. Reading it back out here means these tests exercise the real
 * path, templates and transport included, instead of a test-only shortcut.
 */
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

async function signupAndVerify(overrides = {}) {
  const credentials = { ...CREDENTIALS, ...overrides };

  const token = await captureEmailedToken(() => call('/signup', { body: credentials }));
  await call('/verify-email', { body: { token } });

  return credentials;
}

// --- signup ----------------------------------------------------------------

describe('POST /api/auth/signup', { skip }, () => {
  it('creates an unverified user and returns no session', async () => {
    const response = await call('/signup', { body: CREDENTIALS });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);

    // A session here would let anyone in without confirming the address, and
    // would also make this response differ from the already-registered case.
    assert.equal(response.body.data.accessToken, undefined);
    assert.equal(refreshCookieFrom(response).raw, undefined);

    const user = await User.findOne({ email: CREDENTIALS.email });
    assert.ok(user, 'user was not created');
    assert.equal(user.emailVerifiedAt, null);
    assert.equal(user.role, 'user');
  });

  it('stores a bcrypt hash, never the password', async () => {
    await call('/signup', { body: CREDENTIALS });

    const user = await User.findOne({ email: CREDENTIALS.email }).select('+passwordHash');

    assert.notEqual(user.passwordHash, CREDENTIALS.password);
    assert.match(user.passwordHash, /^\$2[aby]\$/, 'not a bcrypt hash');
  });

  it('leaves the password hash out of every response', async () => {
    await call('/signup', { body: CREDENTIALS });
    const login = await call('/login', { body: CREDENTIALS });

    assert.equal(JSON.stringify(login.body).includes('passwordHash'), false);
    assert.equal(login.body.data.user.passwordHash, undefined);
  });

  it('lowercases and trims the email so uniqueness holds', async () => {
    await call('/signup', { body: { ...CREDENTIALS, email: '  MiXeD@Example.COM  ' } });

    assert.ok(await User.findOne({ email: 'mixed@example.com' }));
  });

  it('answers a duplicate address identically to a new one', async () => {
    const first = await call('/signup', { body: CREDENTIALS });
    const second = await call('/signup', { body: { ...CREDENTIALS, name: 'Someone Else' } });

    // Byte-identical, so signup cannot be used to test which addresses exist.
    assert.equal(second.status, first.status);
    assert.deepEqual(second.body, first.body);

    assert.equal(await User.countDocuments({ email: CREDENTIALS.email }), 1);
    // And the existing account is untouched.
    assert.equal((await User.findOne({ email: CREDENTIALS.email })).name, CREDENTIALS.name);
  });

  it('rejects a short password, a bad address and a missing name', async () => {
    const cases = [
      { body: { ...CREDENTIALS, password: 'short' }, field: 'password' },
      { body: { ...CREDENTIALS, email: 'not-an-email' }, field: 'email' },
      { body: { email: CREDENTIALS.email, password: CREDENTIALS.password }, field: 'name' },
    ];

    for (const { body, field } of cases) {
      const response = await call('/signup', { body });

      assert.equal(response.status, 400, `${field} was accepted`);
      assert.ok(
        response.body.error.details.some((d) => d.field === field),
        `no error reported for ${field}`,
      );
    }

    assert.equal(await User.countDocuments({}), 0);
  });

  it('rejects a password longer than bcrypt can hash', async () => {
    // bcrypt ignores everything past 72 bytes, so accepting a longer password
    // would mean silently authenticating on a prefix of it.
    const response = await call('/signup', {
      body: { ...CREDENTIALS, password: 'a'.repeat(73) },
    });

    assert.equal(response.status, 400);
  });
});

// --- login -----------------------------------------------------------------

describe('POST /api/auth/login', { skip }, () => {
  it('returns an access token in the body and the refresh token only in a cookie', async () => {
    await signupAndVerify();
    const response = await call('/login', { body: CREDENTIALS });

    assert.equal(response.status, 200);
    assert.ok(response.body.data.accessToken, 'no access token');
    assert.equal(response.body.data.user.email, CREDENTIALS.email);

    const cookie = refreshCookieFrom(response);
    assert.ok(cookie.value, 'no refresh cookie');

    // httpOnly is what stops an XSS bug from reading the long-lived token.
    assert.match(cookie.raw, /HttpOnly/i);
    assert.match(cookie.raw, /Path=\/api\/auth/i);

    // The refresh token must never be readable by JavaScript, so it must not
    // appear in the body as well.
    assert.equal(JSON.stringify(response.body).includes(cookie.value), false);
  });

  it('gives the same answer for a wrong password and an unknown address', async () => {
    await signupAndVerify();

    const wrongPassword = await call('/login', { body: { ...CREDENTIALS, password: 'wrong pw' } });
    const unknownEmail = await call('/login', {
      body: { ...CREDENTIALS, email: 'nobody@example.com' },
    });

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);
    assert.equal(unknownEmail.body.error.message, wrongPassword.body.error.message);
  });

  it('allows an unverified user to sign in', async () => {
    // Verification gates the free credit grant in a later phase, not access.
    await call('/signup', { body: CREDENTIALS });

    const response = await call('/login', { body: CREDENTIALS });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.user.emailVerified, false);
  });

  it('rejects an operator object where a string belongs', async () => {
    await signupAndVerify();

    // Passed straight to findOne, {$gt: ""} would match the first user in the
    // collection. Zod rejects it before any query runs.
    const response = await call('/login', {
      body: { email: { $gt: '' }, password: { $gt: '' } },
    });

    assert.equal(response.status, 400);
  });
});

// --- current user ----------------------------------------------------------

describe('GET /api/auth/me', { skip }, () => {
  it('returns the signed-in user', async () => {
    await signupAndVerify();
    const { body } = await call('/login', { body: CREDENTIALS });

    const response = await call('/me', { method: 'GET', token: body.data.accessToken });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.user.email, CREDENTIALS.email);
    assert.equal(response.body.data.user.emailVerified, true);
  });

  it('refuses a missing, malformed or tampered token', async () => {
    await signupAndVerify();
    const { body } = await call('/login', { body: CREDENTIALS });
    const valid = body.data.accessToken;

    const cases = {
      missing: undefined,
      'not a jwt': 'garbage',
      // Same header and payload, different signature: this is the forgery attempt
      // the shared secret exists to stop.
      'tampered signature': `${valid.split('.').slice(0, 2).join('.')}.AAAA`,
    };

    for (const [label, token] of Object.entries(cases)) {
      const response = await call('/me', { method: 'GET', token });
      assert.equal(response.status, 401, `${label} was accepted`);
    }
  });
});

// --- refresh rotation ------------------------------------------------------

describe('POST /api/auth/refresh', { skip }, () => {
  it('rotates the token and retires the old one', async () => {
    await signupAndVerify();
    const login = await call('/login', { body: CREDENTIALS });
    const first = refreshCookieFrom(login).value;

    const refreshed = await call('/refresh', { cookie: first });
    const second = refreshCookieFrom(refreshed).value;

    assert.equal(refreshed.status, 200);
    assert.ok(refreshed.body.data.accessToken);
    assert.notEqual(second, first, 'the refresh token was not rotated');

    // The new one works.
    assert.equal((await call('/refresh', { cookie: second })).status, 200);
  });

  it('revokes the whole session when a used token is replayed', async () => {
    await signupAndVerify();
    const login = await call('/login', { body: CREDENTIALS });
    const stolen = refreshCookieFrom(login).value;

    const refreshed = await call('/refresh', { cookie: stolen });
    const current = refreshCookieFrom(refreshed).value;

    // An attacker with a copy of the old token tries it.
    const replay = await call('/refresh', { cookie: stolen });
    assert.equal(replay.status, 401);

    // The victim's current token dies too. We cannot tell a theft from a retry,
    // so the session ends and the real user signs in again - which is the
    // outcome that does not leave an attacker holding a live session.
    assert.equal((await call('/refresh', { cookie: current })).status, 401);

    const live = await Token.countDocuments({ type: TOKEN_TYPES.REFRESH, revokedAt: null });
    assert.equal(live, 0, 'tokens survived the family revocation');
  });

  it('refuses an unknown token and a missing cookie', async () => {
    assert.equal((await call('/refresh')).status, 401);
    assert.equal((await call('/refresh', { cookie: 'a'.repeat(43) })).status, 401);
  });
});

// --- logout ----------------------------------------------------------------

describe('POST /api/auth/logout', { skip }, () => {
  it('ends the session and clears the cookie', async () => {
    await signupAndVerify();
    const login = await call('/login', { body: CREDENTIALS });
    const cookie = refreshCookieFrom(login).value;

    const response = await call('/logout', { cookie });

    assert.equal(response.status, 200);
    // Attributes have to match the ones it was set with or the browser ignores it.
    assert.match(refreshCookieFrom(response).raw, /Path=\/api\/auth/i);

    assert.equal((await call('/refresh', { cookie })).status, 401);
  });

  it('succeeds when there was no session to end', async () => {
    assert.equal((await call('/logout')).status, 200);
  });
});

// --- email verification ----------------------------------------------------

describe('POST /api/auth/verify-email', { skip }, () => {
  it('verifies once and then refuses the same link', async () => {
    const token = await captureEmailedToken(() => call('/signup', { body: CREDENTIALS }));
    assert.ok(token, 'no verification link was emailed');

    const first = await call('/verify-email', { body: { token } });
    assert.equal(first.status, 200);
    assert.equal(first.body.data.user.emailVerified, true);

    // Single use: a link that keeps working is a link that keeps being a risk if
    // the mailbox is ever compromised.
    assert.equal((await call('/verify-email', { body: { token } })).status, 400);
  });

  it('refuses an expired link', async () => {
    const token = await captureEmailedToken(() => call('/signup', { body: CREDENTIALS }));

    await Token.updateOne(
      { type: TOKEN_TYPES.EMAIL_VERIFY },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    );

    assert.equal((await call('/verify-email', { body: { token } })).status, 400);
    assert.equal((await User.findOne({})).emailVerifiedAt, null);
  });

  it('invalidates the previous link when a new one is requested', async () => {
    const firstToken = await captureEmailedToken(() => call('/signup', { body: CREDENTIALS }));
    const secondToken = await captureEmailedToken(() =>
      call('/resend-verification', { body: { email: CREDENTIALS.email } }),
    );

    assert.notEqual(secondToken, firstToken);
    assert.equal((await call('/verify-email', { body: { token: firstToken } })).status, 400);
    assert.equal((await call('/verify-email', { body: { token: secondToken } })).status, 200);
  });

  it('answers resend identically for a registered and an unknown address', async () => {
    await call('/signup', { body: CREDENTIALS });

    const known = await call('/resend-verification', { body: { email: CREDENTIALS.email } });
    const unknown = await call('/resend-verification', { body: { email: 'nobody@example.com' } });

    assert.equal(unknown.status, known.status);
    assert.deepEqual(unknown.body, known.body);
  });
});

// --- password reset --------------------------------------------------------

describe('password reset', { skip }, () => {
  it('answers forgot-password identically whether or not the account exists', async () => {
    await signupAndVerify();

    const known = await call('/forgot-password', { body: { email: CREDENTIALS.email } });
    const unknown = await call('/forgot-password', { body: { email: 'nobody@example.com' } });

    assert.equal(unknown.status, known.status);
    assert.deepEqual(unknown.body, known.body);

    // Nothing was created for the address that does not exist.
    assert.equal(await Token.countDocuments({ type: TOKEN_TYPES.PASSWORD_RESET }), 1);
  });

  it('changes the password, retires the link, and signs out everywhere', async () => {
    await signupAndVerify();

    const login = await call('/login', { body: CREDENTIALS });
    const oldSession = refreshCookieFrom(login).value;

    const token = await captureEmailedToken(() =>
      call('/forgot-password', { body: { email: CREDENTIALS.email } }),
    );
    assert.ok(token, 'no reset link was emailed');

    const newPassword = 'a totally different passphrase';
    const reset = await call('/reset-password', { body: { token, password: newPassword } });
    assert.equal(reset.status, 200);

    // The new password works and the old one does not.
    assert.equal((await call('/login', { body: { ...CREDENTIALS, password: newPassword } })).status, 200);
    assert.equal((await call('/login', { body: CREDENTIALS })).status, 401);

    // Whoever knew the old password no longer holds a live session.
    assert.equal((await call('/refresh', { cookie: oldSession })).status, 401);

    // And the link cannot be replayed.
    assert.equal(
      (await call('/reset-password', { body: { token, password: 'yet another passphrase' } })).status,
      400,
    );
  });

  it('applies the password policy to the new password', async () => {
    await signupAndVerify();
    const token = await captureEmailedToken(() =>
      call('/forgot-password', { body: { email: CREDENTIALS.email } }),
    );

    const response = await call('/reset-password', { body: { token, password: 'short' } });

    assert.equal(response.status, 400);
    // A rejected attempt must not burn the link.
    assert.equal((await Token.findOne({ type: TOKEN_TYPES.PASSWORD_RESET })).usedAt, null);
  });

  it('refuses an unknown reset token', async () => {
    const response = await call('/reset-password', {
      body: { token: 'x'.repeat(43), password: 'a perfectly fine passphrase' },
    });

    assert.equal(response.status, 400);
  });
});

// --- storage guarantees ----------------------------------------------------

describe('token storage', { skip }, () => {
  it('stores only hashes, never a usable token', async () => {
    const emailed = await captureEmailedToken(() => call('/signup', { body: CREDENTIALS }));
    const login = await call('/login', { body: CREDENTIALS });
    const refreshToken = refreshCookieFrom(login).value;

    const stored = await Token.find({}).lean();
    assert.equal(stored.length, 2);

    const serialised = JSON.stringify(stored);
    assert.equal(serialised.includes(emailed), false, 'a verification token was stored in the clear');
    assert.equal(serialised.includes(refreshToken), false, 'a refresh token was stored in the clear');

    for (const doc of stored) {
      assert.match(doc.tokenHash, /^[a-f0-9]{64}$/, 'not a sha-256 hash');
    }
  });
});
