import { logger } from '../config/logger.js';

/**
 * Logs one line per request, after the response has been sent, so the status
 * code and duration are known.
 */
export function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    logger.info(`${req.method} ${req.originalUrl} ${res.statusCode}`, {
      durationMs: Math.round(durationMs),
    });
  });

  next();
}
