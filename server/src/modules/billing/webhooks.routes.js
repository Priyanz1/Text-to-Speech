import express, { Router } from 'express';

import { env } from '../../config/env.js';

import * as webhooksController from './webhooks.controller.js';

export const webhooksRouter = Router();

/**
 * Mounted in app.js BEFORE express.json(), and that order is not a style choice.
 *
 * A webhook signature is an HMAC over the exact bytes the provider sent. Once
 * express.json() has parsed the body, those bytes are gone: JSON.stringify of the
 * parsed object is not guaranteed to reproduce them - key order, whitespace and
 * number formatting are all free to differ - so every signature would fail. The
 * raw parser below has to see the request first.
 *
 * Deliberately not behind requireAuth (the caller is Razorpay, not a user) and
 * deliberately not behind the global rate limiter (Razorpay retries from its own
 * addresses, and a burst of retries after an outage is exactly when the webhook
 * must not be refused).
 */
webhooksRouter.post(
  '/razorpay',
  express.raw({ type: 'application/json', limit: env.JSON_BODY_LIMIT }),
  webhooksController.razorpayWebhook,
);
