import { createApp } from './app.js';
import { env, isDevelopment, isProduction } from './config/env.js';
import { refreshCookieOptions } from './config/cookies.js';
import { logger } from './config/logger.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import * as payments from './integrations/payments/index.js';
import * as storage from './integrations/storage/index.js';
import * as ttsProvider from './integrations/ttsProvider/index.js';
import { markShuttingDown } from './utils/lifecycle.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Shouts about configuration that is fine locally and wrong in production.
 *
 * Every one of these is a setting whose development default is deliberately a
 * no-op - a mock provider, local disk, a logged email - and every one of them fails
 * silently in production. A mock payment provider does not error; it hands out
 * credits for free. Local audio storage does not error; it loses every file on the
 * next deploy. Silence is the failure mode, so this makes noise instead.
 *
 * Warnings, not a refusal to boot: a deployment that is deliberately staged this
 * way should still start, and an operator who cannot read the logs has a bigger
 * problem than this check can solve.
 */
function warnAboutProductionConfig() {
  if (!isProduction) return;

  const problems = [];

  if (env.PAYMENT_PROVIDER === 'mock') {
    problems.push('PAYMENT_PROVIDER=mock - every "purchase" grants credits without taking money');
  }

  if (env.TTS_PROVIDER === 'mock') {
    problems.push('TTS_PROVIDER=mock - generated audio is a synthetic tone, not speech');
  }

  if (env.STORAGE_PROVIDER === 'local') {
    problems.push(
      'STORAGE_PROVIDER=local - audio is written to the container filesystem and is lost on every deploy',
    );
  }

  if (env.EMAIL_PROVIDER === 'log') {
    problems.push(
      'EMAIL_PROVIDER=log - verification and reset emails are only written to the log, so nobody can verify an account',
    );
  }

  if (env.CLIENT_URL.includes('localhost') || env.CLIENT_URL.includes('127.0.0.1')) {
    problems.push(`CLIENT_URL=${env.CLIENT_URL} - CORS will refuse the real front end`);
  }

  if (!env.RATE_LIMIT_ENABLED) {
    problems.push('RATE_LIMIT_ENABLED=false - login and TTS have no request ceiling');
  }

  /**
   * The client and the API are on different origins in this deployment (separate
   * Render services), which makes the refresh cookie cross-site. A cross-site
   * cookie is only sent when SameSite=None, so anything else here means every
   * refresh silently fails and users are signed out when their access token
   * expires - a bug that looks like an auth bug and is a cookie setting.
   */
  if (refreshCookieOptions.sameSite !== 'none') {
    problems.push(
      `COOKIE_SAMESITE=${refreshCookieOptions.sameSite} - the refresh cookie will not be sent from a front end on another origin`,
    );
  }

  if (!refreshCookieOptions.secure) {
    problems.push('The refresh cookie is not marked Secure');
  }

  for (const problem of problems) {
    logger.warn(`Production configuration warning: ${problem}`);
  }

  if (problems.length === 0) {
    logger.info('Production configuration check passed');
  }
}

const app = createApp();

// No host argument, so Node binds to all interfaces. Render routes to the
// container's port and would not reach a server bound only to 127.0.0.1.
const server = app.listen(env.PORT, () => {
  logger.info(
    isDevelopment ? `Server listening on http://localhost:${env.PORT}` : 'Server listening',
    { port: env.PORT, environment: env.NODE_ENV },
  );

  // Which provider is live is never worth guessing at, especially the ones that
  // cost money per request or move money.
  logger.info(`Speech provider: ${ttsProvider.describe()}`);
  logger.info(`Audio storage: ${storage.describe()}`);
  logger.info(`Email provider: ${env.EMAIL_PROVIDER}`);
  logger.info(`Payment provider: ${payments.describe()}`);

  warnAboutProductionConfig();
});

// Connect to MongoDB *after* the server is listening, and do not treat failure
// as fatal. The process stays up, GET /api/health keeps returning 200 (the
// process is fine), and GET /api/ready returns 503 (it cannot serve traffic).
connectDatabase().catch((error) => {
  logger.error('Initial MongoDB connection failed - /api/ready will report unavailable', {
    message: error.message,
  });
});

let isShuttingDown = false;

async function shutdown(reason) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  // Fail readiness immediately so a load balancer stops sending new requests
  // here while the in-flight ones below are still finishing.
  markShuttingDown();

  logger.info(`Shutting down (${reason})`);

  // Escape hatch: if a connection refuses to close, do not hang forever.
  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    // Stop accepting new connections, then wait for in-flight requests.
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    logger.info('HTTP server closed');

    await disconnectDatabase();

    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', { message: error.message });
    process.exit(1);
  }
}

// SIGTERM is what hosting platforms send on deploy or scale-down.
// SIGINT is Ctrl+C in your terminal.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}

// A bug escaped every handler. Log it and exit; the platform will restart us.
// Continuing after these leaves the process in an unknown state.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  shutdown('unhandledRejection');
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { message: error.message, stack: error.stack });
  shutdown('uncaughtException');
});
