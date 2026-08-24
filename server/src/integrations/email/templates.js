import { env } from '../../config/env.js';

/**
 * Plain-text emails on purpose. Every client renders them, nothing to break
 * across Outlook and Gmail, and a URL on its own line is already clickable.
 * HTML versions can be added here later without touching any caller.
 */

export function verificationEmail({ name, url, ttlMinutes }) {
  return {
    subject: 'Confirm your email address',
    text: [
      `Hi ${name},`,
      '',
      'Confirm your email address to finish setting up your account:',
      '',
      url,
      '',
      `This link expires in ${formatMinutes(ttlMinutes)} and can only be used once.`,
      '',
      'If you did not create this account, you can ignore this email.',
    ].join('\n'),
  };
}

export function passwordResetEmail({ name, url, ttlMinutes }) {
  return {
    subject: 'Reset your password',
    text: [
      `Hi ${name},`,
      '',
      'Use this link to choose a new password:',
      '',
      url,
      '',
      `This link expires in ${formatMinutes(ttlMinutes)} and can only be used once.`,
      '',
      'If you did not ask to reset your password, you can ignore this email -',
      'your current password still works.',
    ].join('\n'),
  };
}

/**
 * Sent when someone signs up with an address that already has an account.
 *
 * Signup answers identically whether or not the email is taken, so that the
 * response cannot be used to test which addresses are registered. This email is
 * what keeps that from being confusing: the person who actually owns the address
 * finds out what happened, and nobody else learns anything.
 */
export function accountExistsEmail({ name, loginUrl, resetUrl }) {
  return {
    subject: 'You already have an account',
    text: [
      `Hi ${name},`,
      '',
      'Someone tried to sign up using this email address, but it already has an',
      'account. No new account was created and nothing has changed.',
      '',
      `If that was you, sign in instead:  ${loginUrl}`,
      `Forgotten your password?           ${resetUrl}`,
      '',
      'If it was not you, you can safely ignore this email.',
    ].join('\n'),
  };
}

export const clientUrls = {
  login: () => `${env.CLIENT_URL}/login`,
  forgotPassword: () => `${env.CLIENT_URL}/forgot-password`,
  verifyEmail: (token) => `${env.CLIENT_URL}/verify-email?token=${token}`,
  resetPassword: (token) => `${env.CLIENT_URL}/reset-password?token=${token}`,
};

function formatMinutes(minutes) {
  if (minutes % (60 * 24) === 0) {
    const days = minutes / (60 * 24);
    return days === 1 ? '1 day' : `${days} days`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  return `${minutes} minutes`;
}
