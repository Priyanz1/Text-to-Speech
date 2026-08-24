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
 * A boolean from an environment variable.
 *
 * Not z.coerce.boolean(), which treats every non-empty string as true - so
 * "false" would be true, which is the worst possible failure mode for a flag
 * whose whole job is to turn something off.
 */
const envBoolean = (fallback) =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform((value) => value === 'true');

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

  /**
   * Where generated audio is written.
   *
   *   local - files under GENERATED_AUDIO_DIR. Right for development, and wrong
   *           for Render: the disk is ephemeral, so a deploy takes every file and
   *           leaves the Generation rows pointing at nothing.
   *   s3    - any S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2,
   *           MinIO). This is the permanent one. See integrations/storage/s3.js.
   */
  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),

  // Relative to the server package root. Git-ignored (`tmp/`).
  GENERATED_AUDIO_DIR: z.string().default('tmp/audio'),

  // Required when STORAGE_PROVIDER=s3.
  S3_BUCKET: z.string().default(''),

  // AWS needs a real region. R2 wants the literal 'auto'; B2 and MinIO ignore it
  // but SigV4 still has to sign *something*, so it is never blank.
  S3_REGION: z.string().default('auto'),

  // Blank means real AWS S3, addressed virtual-host style. Set it for anything
  // else - R2 is https://<account-id>.r2.cloudflarestorage.com.
  S3_ENDPOINT: z.string().default(''),

  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),

  // Bucket in the path (endpoint/bucket/key) rather than the hostname. What R2,
  // MinIO and most non-AWS implementations want. Ignored when S3_ENDPOINT is
  // blank, because AWS deprecated path style.
  S3_FORCE_PATH_STYLE: envBoolean(true),

  // Hard ceiling on one request's input, in UTF-8 bytes. Google's synthesize
  // endpoint rejects a request whose payload exceeds 5000 bytes; staying under
  // it is our job, because a rejected call still costs a round trip and the
  // error it returns is not one a user can act on.
  TTS_MAX_INPUT_BYTES: z.coerce.number().int().min(100).max(5_000).default(4_800),

  // -------------------------------------------------------------------------
  // Payments
  // -------------------------------------------------------------------------

  /**
   * 'mock' keeps checkout runnable with no Razorpay account: orders and
   * subscriptions get local ids, and the webhook is signed with the same secret
   * the server verifies with, so the whole grant path - order, payment, webhook,
   * ledger row, balance - is exercised for real. It never moves money and never
   * leaves the machine.
   *
   * 'razorpay' talks to Razorpay. Test and live mode are the same code path: the
   * mode is a property of the key pair, not of this setting.
   */
  PAYMENT_PROVIDER: z.enum(['razorpay', 'mock']).default('mock'),

  // rzp_test_... or rzp_live_... The key id is public - the browser needs it to
  // open Checkout, and the API returns it with every order.
  RAZORPAY_KEY_ID: z.string().default(''),

  // Secret. Signs API calls and verifies the Checkout handler's signature.
  RAZORPAY_KEY_SECRET: z.string().default(''),

  /**
   * A different secret from the key secret, set per webhook in the Razorpay
   * dashboard. Required when PAYMENT_PROVIDER=razorpay: without it there is no
   * way to tell a real delivery from a forged POST, and the webhook is the only
   * thing that grants credits.
   */
  RAZORPAY_WEBHOOK_SECRET: z.string().default(''),

  // -------------------------------------------------------------------------
  // Hardening
  // -------------------------------------------------------------------------

  // Largest JSON body accepted. The biggest legitimate one is a TTS request at
  // TTS_MAX_INPUT_BYTES (under 5 KB) plus a few short fields, so this is roughly
  // 20x headroom and still small enough that a body flood costs the process
  // nothing. Webhooks parse their own raw body under the same ceiling.
  JSON_BODY_LIMIT: z.string().default('100kb'),

  // Off in tests, where the suite fires hundreds of requests from one address and
  // a limiter would fail them instead of the code under test.
  RATE_LIMIT_ENABLED: envBoolean(true),

  // The window every limit below is counted over.
  RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1_440).default(15),

  // Per IP, on the credential endpoints only: login, signup, the two email flows,
  // password reset. Low, because these are the ones worth brute forcing.
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).default(20),

  // Per user. Every generation spends real provider money, so this is a spend
  // ceiling as much as an abuse one.
  RATE_LIMIT_TTS_MAX: z.coerce.number().int().min(1).default(40),

  // Per user, on order and subscription creation. A created order is a row in
  // Razorpay's system too, so a loop here makes a mess in someone else's
  // dashboard as well as ours.
  RATE_LIMIT_PAYMENT_MAX: z.coerce.number().int().min(1).default(20),

  // Per IP, across the whole API, as a backstop for anything not covered above.
  // Generous: a normal session's page loads, polls and refreshes are all in here.
  RATE_LIMIT_API_MAX: z.coerce.number().int().min(1).default(600),
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
  // One rule per missing credential rather than one combined rule, so the boot
  // failure names the variable you actually have to go and find.
  .refine((value) => value.PAYMENT_PROVIDER !== 'razorpay' || value.RAZORPAY_KEY_ID.length > 0, {
    path: ['RAZORPAY_KEY_ID'],
    message: 'RAZORPAY_KEY_ID is required when PAYMENT_PROVIDER is "razorpay"',
  })
  .refine((value) => value.PAYMENT_PROVIDER !== 'razorpay' || value.RAZORPAY_KEY_SECRET.length > 0, {
    path: ['RAZORPAY_KEY_SECRET'],
    message: 'RAZORPAY_KEY_SECRET is required when PAYMENT_PROVIDER is "razorpay"',
  })
  /**
   * The webhook secret is not optional even though nothing would visibly break
   * without it. Purchased credits are granted only by the webhook, and the only
   * thing separating a real delivery from an unauthenticated POST that mints
   * credits is this signature. A missing secret has to stop the boot.
   */
  .refine(
    (value) => value.PAYMENT_PROVIDER !== 'razorpay' || value.RAZORPAY_WEBHOOK_SECRET.length > 0,
    {
      path: ['RAZORPAY_WEBHOOK_SECRET'],
      message:
        'RAZORPAY_WEBHOOK_SECRET is required when PAYMENT_PROVIDER is "razorpay" - it is what proves a webhook came from Razorpay, and the webhook is what grants credits',
    },
  )
  .refine((value) => value.STORAGE_PROVIDER !== 's3' || value.S3_BUCKET.length > 0, {
    path: ['S3_BUCKET'],
    message: 'S3_BUCKET is required when STORAGE_PROVIDER is "s3"',
  })
  .refine(
    (value) =>
      value.STORAGE_PROVIDER !== 's3' ||
      (value.S3_ACCESS_KEY_ID.length > 0 && value.S3_SECRET_ACCESS_KEY.length > 0),
    {
      path: ['S3_ACCESS_KEY_ID'],
      message:
        'S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are both required when STORAGE_PROVIDER is "s3"',
    },
  )
  .refine((value) => value.S3_ENDPOINT === '' || /^https?:\/\//.test(value.S3_ENDPOINT), {
    path: ['S3_ENDPOINT'],
    message: 'S3_ENDPOINT must start with http:// or https:// (or be blank for real AWS S3)',
  })
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
export const isTest = env.NODE_ENV === 'test';

// Trailing slash stripped so s3.js can join it to a key without producing a
// double slash, which some S3 implementations sign differently from how they
// store it.
export const s3Endpoint = env.S3_ENDPOINT ? stripTrailingSlash(env.S3_ENDPOINT) : '';
