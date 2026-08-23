import { env } from '../../config/env.js';
import { getDatabaseStatus } from '../../config/db.js';

/**
 * Reports whether this instance is ready to serve traffic.
 *
 * Returns 503 when MongoDB is not connected. That is intentional: a hosting
 * platform's readiness probe should pull an unhealthy instance out of rotation
 * rather than send it requests that are going to fail.
 */
export function getHealth(req, res) {
  const database = getDatabaseStatus();
  const isHealthy = database === 'connected';

  res.status(isHealthy ? 200 : 503).json({
    success: isHealthy,
    data: {
      status: isHealthy ? 'ok' : 'degraded',
      environment: env.NODE_ENV,
      database,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    },
  });
}
