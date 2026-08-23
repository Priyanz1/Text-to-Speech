import { isProduction } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * The only place in the codebase that turns an error into an HTTP response.
 *
 * Express identifies error middleware by its four-argument signature, so
 * `next` must stay in the parameter list even though it is unused.
 *
 * Express 5 forwards rejected promises from async route handlers here
 * automatically, so route code needs no try/catch wrapper.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const isApiError = err instanceof ApiError;

  // Errors thrown by Express internals (express.json on a malformed body, on a
  // payload over the size limit) carry their own 4xx status. Honour it instead
  // of reporting a client mistake as a server fault.
  const libraryStatus = Number(err.statusCode ?? err.status);
  const hasClientStatus =
    Number.isInteger(libraryStatus) && libraryStatus >= 400 && libraryStatus < 500;

  const statusCode = isApiError ? err.statusCode : hasClientStatus ? libraryStatus : 500;

  // `expose` is the http-errors convention for "this message is safe to show
  // the client". Anything else could contain a connection string, a file path
  // or a query fragment, so it is replaced with a generic message.
  const canExposeMessage = isApiError || (hasClientStatus && err.expose === true);
  const message = canExposeMessage
    ? err.message
    : statusCode === 500
      ? 'Internal server error'
      : 'Bad request';

  const context = { method: req.method, url: req.originalUrl, statusCode };

  if (statusCode >= 500) {
    logger.error(err.message, { ...context, stack: err.stack });
  } else {
    logger.warn(err.message, context);
  }

  res.status(statusCode).json({
    success: false,
    error: {
      message,
      ...(isApiError && err.details ? { details: err.details } : {}),
      ...(isProduction ? {} : { stack: err.stack }),
    },
  });
}
