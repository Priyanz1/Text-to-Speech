/**
 * Turns an API error into one line a person can act on.
 *
 * A 400 from the validation middleware carries the useful part in
 * `error.payload.error.details` - which field, and what is wrong with it. The
 * top-level message for those is just "Validation failed", which tells the user
 * nothing.
 */
export function toFormMessage(error) {
  const details = error.payload?.error?.details;

  if (Array.isArray(details) && details.length > 0) {
    return details.map((detail) => detail.message).join(' ');
  }

  return error.message;
}
