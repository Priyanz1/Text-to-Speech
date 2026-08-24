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
});

const parsed = envSchema.safeParse(process.env);

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
