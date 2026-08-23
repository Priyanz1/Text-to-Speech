import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`Server listening on http://localhost:${env.PORT}`, {
    environment: env.NODE_ENV,
  });
});

// Connect to MongoDB *after* the server is listening, and do not treat failure
// as fatal. The process stays up and GET /api/health reports 503 with
// database: "disconnected", which is what a readiness probe needs to see.
connectDatabase().catch((error) => {
  logger.error('Initial MongoDB connection failed - /api/health will report degraded', {
    message: error.message,
  });
});

let isShuttingDown = false;

async function shutdown(reason) {
  if (isShuttingDown) return;
  isShuttingDown = true;

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
