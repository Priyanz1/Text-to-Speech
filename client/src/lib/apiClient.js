import { env } from '../config/env.js';

/**
 * The single place the frontend talks to the API.
 *
 * The access token is held in this module variable and nowhere else - not in
 * localStorage, not in sessionStorage, not in a readable cookie. That means an
 * XSS bug cannot read it out of storage, and it disappears when the tab closes.
 * The cost is that a page reload loses it, which is what bootstrapSession is for:
 * the refresh cookie survives the reload and buys a new access token.
 */
let accessToken = null;

// One shared refresh, so a page that fires five requests at once and gets five
// 401s does not start five rotations - which, because each rotation retires the
// previous token, would look exactly like token theft and end the session.
let refreshPromise = null;

let onSessionExpired = () => {};

export function getAccessToken() {
  return accessToken;
}

export function setAccessToken(token) {
  accessToken = token;
}

/** Lets AuthProvider hear about a session that could not be renewed. */
export function setSessionExpiredHandler(handler) {
  onSessionExpired = handler;
}

async function rawRequest(path, { method = 'GET', body, headers, signal, responseType = 'json' } = {}) {
  let response;

  try {
    response = await fetch(`${env.apiBaseUrl}${path}`, {
      method,
      // Sends the refresh cookie. Required for /api/auth/refresh and logout.
      credentials: 'include',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    // fetch only rejects on network-level failures: server down, DNS, CORS,
    // or an aborted request. An HTTP error status does NOT land here.
    const error = new Error(`Cannot reach the API at ${env.apiBaseUrl}. Is the server running?`);
    error.status = 0;
    error.cause = cause;
    throw error;
  }

  if (!response.ok) {
    // Error responses are always JSON or text, never binary, whatever the caller
    // asked for. Read as text first: it may be an HTML page or empty.
    const raw = await response.text();

    let payload = null;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { error: { message: raw.slice(0, 200) } };
      }
    }

    const error = new Error(
      payload?.error?.message ?? `Request failed with status ${response.status}`,
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  /**
   * Audio comes back as a blob, not JSON.
   *
   * It has to come through this client rather than going straight into an
   * <audio src>, because the tag cannot send an Authorization header - so the
   * only alternative would be a signed or public URL, and the audio is private.
   * Fetching it here also means it gets the same silent token refresh as
   * everything else.
   */
  if (responseType === 'blob') return response.blob();

  const raw = await response.text();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return { error: { message: raw.slice(0, 200) } };
  }
}

/**
 * Trades the refresh cookie for a new access token.
 * Resolves to the user on success, or null if the session is over.
 */
function refreshSession() {
  refreshPromise ??= (async () => {
    try {
      // skipAuthRefresh is implicit here: this IS the refresh, so a 401 from it
      // is final rather than something to retry.
      const response = await rawRequest('/api/auth/refresh', { method: 'POST' });
      accessToken = response.data.accessToken;
      return response.data.user;
    } catch {
      accessToken = null;
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/**
 * Called once on page load. The access token is gone, but the refresh cookie is
 * not, so this is what keeps a reload from logging the user out.
 */
export function bootstrapSession() {
  return refreshSession();
}

async function request(path, options = {}) {
  const { skipAuthRefresh = false, ...rest } = options;

  try {
    return await rawRequest(path, rest);
  } catch (error) {
    if (error.status !== 401 || skipAuthRefresh) throw error;

    // Access tokens last minutes, so an expired one is the ordinary case, not an
    // exception. Renew silently and retry once; the user never sees it.
    const user = await refreshSession();

    if (!user) {
      onSessionExpired();
      throw error;
    }

    return rawRequest(path, rest);
  }
}

export const api = {
  get: (path, options) => request(path, { ...options, method: 'GET' }),
  post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
  patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
  delete: (path, options) => request(path, { ...options, method: 'DELETE' }),

  // For the generated audio. Same auth and same retry-on-401 as every other call.
  getBlob: (path, options) => request(path, { ...options, method: 'GET', responseType: 'blob' }),
};
