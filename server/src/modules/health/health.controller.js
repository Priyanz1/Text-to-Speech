import { env } from '../../config/env.js';
import { getDatabaseStatus } from '../../config/db.js';
import { isShuttingDown } from '../../utils/lifecycle.js';

// Fields both endpoints return, so the two responses stay consistent.
function commonFields() {
  return {
    environment: env.NODE_ENV,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Liveness - GET /api/health
 *
 * "Is this Node process alive and able to answer HTTP?" It deliberately checks
 * nothing else, and in particular does not touch MongoDB.
 *
 * A hosting platform *restarts* an instance that fails its health check.
 * Restarting the API does not fix a database outage, it just adds a restart
 * loop on top of one, so a database problem must never fail this endpoint.
 */
export function getLiveness(req, res) {
  res.status(200).json({
    success: true,
    data: {
      status: 'alive',
      ...commonFields(),
    },
  });
}

/**
 * Readiness - GET /api/ready
 *
 * "Should this instance receive application traffic right now?" 503 when
 * MongoDB is not connected, or while we are shutting down.
 *
 * A load balancer *drains* an instance that fails this check, which is the
 * correct response to a dependency being unavailable: stop sending it work,
 * but leave it running so it can recover.
 */
export function getReadiness(req, res) {
  const database = getDatabaseStatus();
  const draining = isShuttingDown();
  const isReady = database === 'connected' && !draining;

  res.status(isReady ? 200 : 503).json({
    success: isReady,
    data: {
      status: isReady ? 'ready' : 'unavailable',
      database,
      draining,
      ...commonFields(),
    },
  });
}
