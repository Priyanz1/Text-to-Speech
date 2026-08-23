import { env } from '../config/env.js';

/**
 * The single place the frontend talks to the API.
 *
 * Routing every call through here means the API base URL, credential handling
 * and error shape are defined once. In Phase 4 this is also where the "on 401,
 * refresh the access token and retry once" logic will live.
 *
 * Built on the browser's native fetch, so it adds no dependency.
 */
async function request(path, { method = 'GET', body, headers, signal } = {}) {
  let response;

  try {
    response = await fetch(`${env.apiBaseUrl}${path}`, {
      method,
      // Send cookies so the refresh-token cookie works in Phase 2.
      credentials: 'include',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    // fetch only rejects on network-level failures: server down, DNS, CORS,
    // or an aborted request. An HTTP error status does NOT land here.
    const error = new Error(
      `Cannot reach the API at ${env.apiBaseUrl}. Is the server running?`,
    );
    error.status = 0;
    error.cause = cause;
    throw error;
  }

  // Read as text first: an error response may be an HTML page or empty.
  const raw = await response.text();

  let payload = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { error: { message: raw.slice(0, 200) } };
    }
  }

  if (!response.ok) {
    const error = new Error(
      payload?.error?.message ?? `Request failed with status ${response.status}`,
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

export const api = {
  get: (path, options) => request(path, { ...options, method: 'GET' }),
  post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
  patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
  delete: (path, options) => request(path, { ...options, method: 'DELETE' }),
};
