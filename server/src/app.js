import express from 'express';
import cors from 'cors';

import { env } from './config/env.js';
import { requestLogger } from './middleware/requestLogger.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';
import { apiRouter } from './routes/index.js';

/**
 * Builds the Express application without starting it.
 *
 * Keeping "build the app" separate from "listen on a port" (src/index.js) means
 * tests can create an app instance without binding a port or opening sockets.
 *
 * Middleware order matters and reads top to bottom:
 *   CORS -> body parsing -> request logging -> routes -> 404 -> error handler
 */
export function createApp() {
  const app = express();

  // Do not advertise the framework in response headers.
  app.disable('x-powered-by');

  // Render, Railway and Fly all sit behind a proxy. Without this, req.ip is the
  // proxy's address, which would make per-IP rate limiting (Phase 9) useless.
  app.set('trust proxy', 1);

  // Only our own frontend may call this API from a browser.
  // `credentials: true` is required for the refresh-token cookie in Phase 2.
  app.use(
    cors({
      origin: env.CLIENT_URL,
      credentials: true,
    }),
  );

  // Cap the body size. The default is 100kb; 1mb leaves room for the long text
  // payloads the TTS endpoint will accept later without allowing huge uploads.
  app.use(express.json({ limit: '1mb' }));

  app.use(requestLogger);

  app.use('/api', apiRouter);

  // Must be the last two, in this order.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
