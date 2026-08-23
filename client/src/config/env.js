/**
 * Reads and validates the browser-side configuration.
 *
 * Vite only exposes variables prefixed with VITE_ to the app, and it inlines
 * them into the built JavaScript bundle at build time. That means every VITE_
 * value is PUBLIC and readable by anyone who opens devtools. Never put an API
 * key, database URI or secret in here - those belong in server/.env only.
 */
const rawApiBaseUrl = import.meta.env.VITE_API_BASE_URL;

if (!rawApiBaseUrl) {
  throw new Error(
    'Missing VITE_API_BASE_URL. Copy client/.env.example to client/.env and restart the dev server.',
  );
}

export const env = {
  // Strip any trailing slash so building paths is always `${base}${path}`.
  apiBaseUrl: rawApiBaseUrl.replace(/\/+$/, ''),
  mode: import.meta.env.MODE,
  isDevelopment: import.meta.env.DEV,
};
