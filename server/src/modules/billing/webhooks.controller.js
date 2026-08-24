import { logger } from '../../config/logger.js';
import { ApiError } from '../../utils/ApiError.js';

import * as billingService from './billing.service.js';

/**
 * The provider's entry point. No session, no user, no CSRF token - the signature
 * over the raw body is the entire authentication story, which is why the raw body
 * has to survive intact all the way to here.
 */
export async function razorpayWebhook(req, res) {
  /**
   * express.raw() leaves a Buffer. Anything else means the parser did not match -
   * usually a caller sending a content type other than application/json - and
   * verifying a signature against a re-serialised object would fail in a way that
   * looks like a forged request.
   */
  if (!Buffer.isBuffer(req.body)) {
    logger.warn('Webhook arrived without a raw body', { contentType: req.headers['content-type'] });
    throw new ApiError(400, 'Webhook body must be raw application/json');
  }

  const result = await billingService.handleWebhook({
    rawBody: req.body,
    signature: req.headers['x-razorpay-signature'],
    eventId: req.headers['x-razorpay-event-id'],
  });

  /**
   * The status code is the only part of this response the provider reads, and it
   * is an instruction: 2xx means stop, anything else means retry. handleWebhook
   * chooses it deliberately - 200 for done and for deliberately-ignored, 409 for a
   * delivery that raced another and should come back.
   */
  res.status(result.httpStatus).json({ success: true, data: { status: result.status } });
}
