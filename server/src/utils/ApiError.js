/**
 * An error we raised on purpose, carrying the HTTP status the client should
 * see. Anything thrown that is NOT an ApiError is treated as an unexpected
 * bug by the error handler and reported as a generic 500, so internal details
 * never leak to the client.
 */
export class ApiError extends Error {
  constructor(statusCode, message, details) {
    super(message);

    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.details = details;

    Error.captureStackTrace?.(this, ApiError);
  }
}
