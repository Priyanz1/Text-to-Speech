import { REFRESH_COOKIE_NAME, clearRefreshCookieOptions, refreshCookieOptions } from '../../config/cookies.js';
import * as authService from './auth.service.js';

/**
 * Controllers stay thin: the body is already validated by middleware, and the
 * rules live in auth.service.js. What is left is HTTP - status codes, the
 * response envelope, and the refresh cookie.
 *
 * Express 5 forwards rejected promises to the error handler, so none of these
 * need a try/catch.
 */

/**
 * Sends the access token in the body and the refresh token in a cookie.
 *
 * They are split on purpose. The access token is read by JavaScript and held in
 * memory, so it dies with the tab and never reaches localStorage. The refresh
 * token is the long-lived one, so it goes somewhere JavaScript cannot read it at
 * all - which means it must never be written into this body.
 */
function sendSession(res, { user, accessToken, refreshToken }, status = 200) {
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions);

  res.status(status).json({
    success: true,
    data: { user: user.toPublicJSON(), accessToken },
  });
}

export async function signup(req, res) {
  await authService.signup(req.body);

  // Identical whether or not the address was already registered, and no session
  // either way - issuing one for an address that already has an account would be
  // a takeover, and issuing one only for new accounts would give the enumeration
  // answer back that the shared message exists to withhold.
  res.status(201).json({
    success: true,
    data: {
      message: 'Check your email to confirm your address and finish signing up.',
    },
  });
}

export async function login(req, res) {
  const session = await authService.login(req.body);
  sendSession(res, session);
}

export async function refresh(req, res) {
  const session = await authService.refresh(req.cookies?.[REFRESH_COOKIE_NAME]);
  sendSession(res, session);
}

export async function logout(req, res) {
  await authService.logout(req.cookies?.[REFRESH_COOKIE_NAME]);

  res.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOptions);

  // Always a success. Logging out of a session that was already gone has the
  // outcome the caller wanted, so reporting an error would be noise.
  res.status(200).json({ success: true, data: { message: 'Signed out.' } });
}

export function getCurrentUser(req, res) {
  res.status(200).json({
    success: true,
    data: { user: req.user.toPublicJSON() },
  });
}

export async function verifyEmail(req, res) {
  const user = await authService.verifyEmail(req.body.token);

  res.status(200).json({
    success: true,
    data: { user: user.toPublicJSON(), message: 'Your email address is confirmed.' },
  });
}

export async function resendVerification(req, res) {
  await authService.resendVerification(req.body.email);

  res.status(200).json({
    success: true,
    data: { message: 'If that address needs confirming, a new link is on its way.' },
  });
}

export async function forgotPassword(req, res) {
  await authService.forgotPassword(req.body.email);

  res.status(200).json({
    success: true,
    data: { message: 'If that address has an account, a reset link is on its way.' },
  });
}

export async function resetPassword(req, res) {
  await authService.resetPassword(req.body);

  // Deliberately not a session. The reset revoked every refresh token, and
  // signing in with the new password proves it is the one they meant to set.
  res.status(200).json({
    success: true,
    data: { message: 'Your password has been changed. You can sign in now.' },
  });
}
