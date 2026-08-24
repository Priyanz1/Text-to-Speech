import { ApiError } from '../utils/ApiError.js';

/**
 * Gate for the admin routes. Must be mounted AFTER requireAuth, which is what
 * puts the user on the request.
 *
 * Role comes from the database row requireAuth just read, not from a claim in the
 * access token. That distinction matters: a token is minted once and lives for
 * fifteen minutes, so a role revoked in the database would otherwise keep working
 * until the token expired.
 *
 * There is no endpoint anywhere that writes `role` - see the update whitelist in
 * users.service.js. Admin is granted by editing the database directly, which
 * means privilege escalation needs database access, not a request.
 */
export function requireAdmin(req, res, next) {
  if (!req.user) {
    // A programming mistake rather than a client one: this middleware was mounted
    // without requireAuth in front of it. 401 is still the correct answer to send.
    next(new ApiError(401, 'Not authenticated'));
    return;
  }

  if (req.user.role !== 'admin') {
    // 403, not 404. Unlike a generation id, the existence of /api/admin is not a
    // secret - it is in the client bundle - so hiding it would buy nothing and
    // make a genuine misconfiguration harder to diagnose.
    next(new ApiError(403, 'This action requires an administrator account.'));
    return;
  }

  next();
}
