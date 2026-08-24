import { Router } from 'express';

import { requireAuth } from '../../middleware/requireAuth.js';
import { validate } from '../../middleware/validate.js';
import * as authController from './auth.controller.js';
import {
  emailOnlySchema,
  loginSchema,
  resetPasswordSchema,
  signupSchema,
  verifyEmailSchema,
} from './auth.validation.js';

export const authRouter = Router();

authRouter.post('/signup', validate(signupSchema), authController.signup);
authRouter.post('/login', validate(loginSchema), authController.login);

// No validate() on either: the refresh token comes from the cookie, not the body.
authRouter.post('/refresh', authController.refresh);
authRouter.post('/logout', authController.logout);

authRouter.get('/me', requireAuth, authController.getCurrentUser);

// Tokens are POSTed in the body rather than read from a query string, so they
// never reach the request logger or any proxy's access log.
authRouter.post('/verify-email', validate(verifyEmailSchema), authController.verifyEmail);
authRouter.post(
  '/resend-verification',
  validate(emailOnlySchema),
  authController.resendVerification,
);

authRouter.post('/forgot-password', validate(emailOnlySchema), authController.forgotPassword);
authRouter.post('/reset-password', validate(resetPasswordSchema), authController.resetPassword);
