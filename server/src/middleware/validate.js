import { ApiError } from '../utils/ApiError.js';

/**
 * Validates and replaces req.body with the parsed result.
 *
 * Two jobs, and the second is the important one:
 *
 * 1. Rejects malformed input with a 400 and a per-field list, rather than
 *    letting it reach a service and fail as a 500.
 * 2. Guarantees types. A JSON body can contain any shape, so an email field can
 *    arrive as {"$gt": ""} - which a naive findOne would happily treat as an
 *    operator and match the first user in the collection. Because every schema
 *    here declares a string, that request is rejected before any query runs.
 *
 * Assigning the parsed value back matters too: it is the trimmed, lowercased,
 * whitelisted version, so handlers cannot accidentally use the raw input or see
 * fields the schema did not declare.
 */
export function validate(schema) {
  return function validateRequest(req, res, next) {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || '(body)',
        message: issue.message,
      }));

      next(new ApiError(400, 'Validation failed', details));
      return;
    }

    req.body = result.data;
    next();
  };
}
