import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { z } from 'zod';

// Resolve .env relative to the server package root so `npm start` works no
// matter which directory the process was launched from.
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(serverRoot, '.env'), quiet: true });

// A browser's Origin header never has a trailing slash, so a CLIENT_URL of
// "https://example.com/" would never match and CORS would fail with no obvious
// cause. Normalise it here rather than debugging it in production.
const stripTrailingSlash = (value) => value.replace(/\/+$/, '');

/**
 * Reads a Google service account key out of an environment variable.
 *
 * Accepts the raw JSON or a base64 encoding of it. Base64 is what the README
 * recommends: the `private_key` field is multi-line, and a multi-line value has
 * to be quoted correctly in a .env file and pasted intact into a dashboard,
 * which is the single easiest part of this setup to get wrong.
 *
 * Returns null for anything unusable, so the schema below can reject it at boot
 * instead of the first generation request failing.
 */
function parseServiceAccount(raw) {
  if (!raw) return null;

  try {
    const trimmed = raw.trim();
    const json = trimmed.startsWith('{') ? trimmed : Buffer.from(trimmed, 'base64').toString('utf8');
    const parsed = JSON.parse(json);

    return parsed?.client_email && parsed?.private_key ? parsed : null;
  } catch {
    return null;
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Render (and most platforms) inject PORT and expect the process to use it.
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  // No default: a wrong database is worse than a missing one, so we make the
  // developer state it explicitly.
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

  // The canonical frontend origin. Also the base for links in emails (Phase 3),
  // which is why it stays a single value rather than becoming a list.
  CLIENT_URL: z.url().default('http://localhost:5173').transform(stripTrailingSlash),

  // Optional extra browser origins allowed through CORS, comma-separated.
  // Exists for Vercel preview deployments, which get a new hostname per branch
  // and would otherwise be blocked by the single CLIENT_URL.
  CORS_EXTRA_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.url()))
    .transform((origins) => origins.map(stripTrailingSlash)),

  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

  // Signs access tokens. No default on purpose: a fallback secret is the kind of
  // thing that quietly ships to production and makes every token forgeable.
  // Generate one with:  node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),

  // Access tokens are deliberately short-lived: they cannot be revoked, so their
  // lifetime *is* the revocation window. The refresh token carries the session.
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  // bcrypt work factor. Configurable so tests can drop it - hashing at cost 12
  // takes hundreds of milliseconds by design, which would dominate a test run.
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),

  // How long a link in an email stays valid, in minutes.
  VERIFY_TOKEN_TTL_MINUTES: z.coerce.number().int().min(5).default(1_440),
  RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().min(5).default(60),

  // 'log' prints the email (including the link) to the server log, which is all
  // local development needs. 'resend' actually sends it. See integrations/email.
  EMAIL_PROVIDER: z.enum(['log', 'resend']).default('log'),
  EMAIL_FROM: z.string().default('AI Text-to-Speech <onboarding@resend.dev>'),
  RESEND_API_KEY: z.string().default(''),

  // Cross-site cookie behaviour. Left blank, this resolves per environment in
  // config/cookies.js - see the comment there, it is the single most likely
  // thing to break auth in production.
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none', '']).default(''),

  // 'google' calls Google Cloud Text-to-Speech. 'mock' returns an audible tone of
  // the right length without leaving the machine, so the whole credit path -
  // reserve, charge, refund, download - is testable and demonstrable before any
  // billing account exists. See integrations/ttsProvider.
  TTS_PROVIDER: z.enum(['google', 'mock']).default('mock'),

  /**
   * The service account key, as raw JSON or base64. Required when
   * TTS_PROVIDER=google.
   *
   * A key in an environment variable rather than GOOGLE_APPLICATION_CREDENTIALS
   * pointing at a file, because Render has no filesystem to put a file on that
   * is not also in the repository - and a service account key in the repository
   * is the exact mistake .gitignore's `gcp-*.json` line exists to prevent.
   */
  GOOGLE_SERVICE_ACCOUNT_JSON: z
    .string()
    .default('')
    .transform((raw) => (raw ? { raw, parsed: parseServiceAccount(raw) } : null)),

  // Where generated audio is written. 'local' puts files under
  // GENERATED_AUDIO_DIR; S3-compatible storage arrives with its own adapter.
  STORAGE_PROVIDER: z.enum(['local']).default('local'),

  // Relative to the server package root. Git-ignored (`tmp/`).
  GENERATED_AUDIO_DIR: z.string().default('tmp/audio'),

  // Hard ceiling on one request's input, in UTF-8 bytes. Google's synthesize
  // endpoint rejects a request whose payload exceeds 5000 bytes; staying under
  // it is our job, because a rejected call still costs a round trip and the
  // error it returns is not one a user can act on.
  TTS_MAX_INPUT_BYTES: z.coerce.number().int().min(100).max(5_000).default(4_800),
});

const parsed = envSchema
  // Cross-field rules. Catching these at boot beats discovering them the first
  // time a user asks for a password reset.
  .refine((value) => value.EMAIL_PROVIDER !== 'resend' || value.RESEND_API_KEY.length > 0, {
    path: ['RESEND_API_KEY'],
    message: 'RESEND_API_KEY is required when EMAIL_PROVIDER is "resend"',
  })
  .refine((value) => value.TTS_PROVIDER !== 'google' || value.GOOGLE_SERVICE_ACCOUNT_JSON !== null, {
    path: ['GOOGLE_SERVICE_ACCOUNT_JSON'],
    message: 'GOOGLE_SERVICE_ACCOUNT_JSON is required when TTS_PROVIDER is "google"',
  })
  // Separate from the rule above so the two failures read differently: "you did
  // not set it" and "what you set is not a usable key" need different fixes.
  .refine(
    (value) =>
      value.GOOGLE_SERVICE_ACCOUNT_JSON === null ||
      value.GOOGLE_SERVICE_ACCOUNT_JSON.parsed !== null,
    {
      path: ['GOOGLE_SERVICE_ACCOUNT_JSON'],
      message:
        'GOOGLE_SERVICE_ACCOUNT_JSON is not a service account key. Expected JSON (or base64 of it) containing client_email and private_key',
    },
  )
  .safeParse(process.env);

if (!parsed.success) {
  // Deliberately console.error and not the logger: the logger imports this
  // module, so it may not exist yet when config is broken.
  console.error('\nInvalid environment configuration:\n');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  console.error('\nCopy server/.env.example to server/.env and fill in the values.\n');
  process.exit(1);
}

export const env = parsed.data;

// The parsed service account, or null when TTS_PROVIDER is not 'google'. Kept
// separate from `env` so the credentials are reached through one named import
// and are easy to grep for.
export const googleServiceAccount = env.GOOGLE_SERVICE_ACCOUNT_JSON?.parsed ?? null;

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
