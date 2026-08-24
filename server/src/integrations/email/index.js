import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * The only way the rest of the codebase sends email.
 *
 * Two transports, chosen by EMAIL_PROVIDER:
 *
 *   log     - writes the message to the server log, including the link. This is
 *             all local development needs: you copy the URL out of your terminal
 *             instead of setting up a domain and DNS records to test signup.
 *   resend  - actually delivers it.
 *
 * Resend is called over plain fetch rather than its SDK, so this whole
 * integration costs zero dependencies. Swapping in SES or Postmark means adding
 * one function here and one enum value in config/env.js.
 */
export async function sendEmail({ to, subject, text }) {
  if (env.EMAIL_PROVIDER === 'resend') {
    await sendViaResend({ to, subject, text });
    return;
  }

  sendViaLog({ to, subject, text });
}

function sendViaLog({ to, subject, text }) {
  // Indented block rather than a JSON meta object: the whole point is that a
  // human reads the link out of this, and JSON would escape every newline.
  const body = text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');

  logger.info(`Email (not sent - EMAIL_PROVIDER=log)\n    To: ${to}\n    Subject: ${subject}\n${body}`);
}

async function sendViaResend({ to, subject, text }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text }),
  });

  if (!response.ok) {
    // Include the provider's own message: "domain is not verified" and "invalid
    // API key" are the two failures worth seeing verbatim.
    const detail = await response.text();
    throw new Error(`Resend rejected the email (${response.status}): ${detail.slice(0, 300)}`);
  }
}
