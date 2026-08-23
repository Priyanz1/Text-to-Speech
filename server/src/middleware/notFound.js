import { ApiError } from '../utils/ApiError.js';

/**
 * Mounted after every route. If a request reaches here, nothing matched it.
 * We hand a 404 to the error handler rather than responding directly, so all
 * error responses are shaped by exactly one piece of code.
 */
export function notFound(req, res, next) {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}
