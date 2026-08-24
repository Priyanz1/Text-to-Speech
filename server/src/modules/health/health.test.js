import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import { markShuttingDown } from '../../utils/lifecycle.js';

/**
 * Covers the liveness/readiness split and the error contract.
 *
 * The app is started on port 0 (an ephemeral port the OS picks) so these tests
 * never collide with a running dev server. No database connection is opened,
 * which is the whole point: liveness must pass without MongoDB, and readiness
 * must fail without it.
 *
 * Uses Node's built-in test runner and fetch, so it adds no dependencies.
 */
let server;
let baseUrl;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // Node's fetch keeps connections alive, and server.close() waits for every
  // open socket. Without closeAllConnections() the callback never fires and the
  // test run hangs instead of finishing.
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await closed;
});

describe('GET /api/health (liveness)', () => {
  it('returns 200 even though MongoDB is not connected', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.status, 'alive');
  });

  it('reports no dependency state, only process state', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    const body = await response.json();

    // If liveness ever grows a dependency check, a dependency outage starts
    // causing container restarts. Assert it stays a pure process check.
    assert.equal(body.data.database, undefined);
    assert.equal(typeof body.data.uptimeSeconds, 'number');
    assert.equal(typeof body.data.timestamp, 'string');
  });
});

describe('GET /api/ready (readiness)', () => {
  it('returns 503 while MongoDB is not connected', async () => {
    const response = await fetch(`${baseUrl}/api/ready`);
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.success, false);
    assert.equal(body.data.status, 'unavailable');
    assert.equal(body.data.database, 'disconnected');
    assert.equal(body.data.draining, false);
  });

  it('uses the same envelope and shared fields as liveness', async () => {
    const [liveness, readiness] = await Promise.all([
      fetch(`${baseUrl}/api/health`).then((r) => r.json()),
      fetch(`${baseUrl}/api/ready`).then((r) => r.json()),
    ]);

    for (const key of ['environment', 'uptimeSeconds', 'timestamp']) {
      assert.ok(key in liveness.data, `liveness is missing ${key}`);
      assert.ok(key in readiness.data, `readiness is missing ${key}`);
    }
  });
});

describe('CORS', () => {
  it('allows the configured client origin', async () => {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: env.CLIENT_URL },
    });

    assert.equal(response.headers.get('access-control-allow-origin'), env.CLIENT_URL);
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  });

  it('omits the allow-origin header for an unknown origin', async () => {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: 'https://not-our-frontend.example.com' },
    });

    // The request still succeeds - CORS is enforced by the browser, which will
    // refuse to hand the response to the page because this header is absent.
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  it('answers a preflight from the allowed origin', async () => {
    const response = await fetch(`${baseUrl}/api/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: env.CLIENT_URL,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), env.CLIENT_URL);
  });

  it('allows requests with no Origin header at all', async () => {
    // curl, and Render's health check probe.
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
  });
});

describe('error contract', () => {
  it('returns a 404 in the standard error shape for an unknown route', async () => {
    const response = await fetch(`${baseUrl}/api/does-not-exist`);
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.success, false);
    assert.match(body.error.message, /Route not found/);
  });

  it('returns 400, not 500, for a malformed JSON body', async () => {
    // Regression test: express.json() throws a SyntaxError carrying status 400.
    // An earlier version of the error handler reported it as a server fault.
    const response = await fetch(`${baseUrl}/api/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"broken":',
    });

    assert.equal(response.status, 400);
    assert.equal((await response.json()).success, false);
  });
});

// Must be the last suite in this file: markShuttingDown() is a one-way switch on
// module state, so anything running after it would see a draining process.
describe('shutdown draining', () => {
  it('flips readiness to draining, and leaves liveness alone', async () => {
    const before = await fetch(`${baseUrl}/api/ready`).then((r) => r.json());
    assert.equal(before.data.draining, false);

    markShuttingDown();

    const readiness = await fetch(`${baseUrl}/api/ready`);
    const body = await readiness.json();
    assert.equal(readiness.status, 503);
    assert.equal(body.data.draining, true);

    // Liveness must still pass: the process is alive and finishing in-flight
    // work. Failing it here would tell the platform to kill us mid-request.
    const liveness = await fetch(`${baseUrl}/api/health`);
    assert.equal(liveness.status, 200);
  });
});
