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
});

const parsed = envSchema
  // Cross-field rules. Catching these at boot beats discovering them the first
  // time a user asks for a password reset.
  .refine((value) => value.EMAIL_PROVIDER !== 'resend' || value.RESEND_API_KEY.length > 0, {
    path: ['RESEND_API_KEY'],
    message: 'RESEND_API_KEY is required when EMAIL_PROVIDER is "resend"',
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

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
