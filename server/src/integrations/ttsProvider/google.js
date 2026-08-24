import jwt from 'jsonwebtoken';

import { env, googleServiceAccount } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * Google Cloud Text-to-Speech over its REST API.
 *
 * No @google-cloud/text-to-speech SDK. The SDK brings gRPC and a large
 * dependency tree to do what two fetch calls do, and the same reasoning already
 * applies to Resend in integrations/email. `jsonwebtoken` is already a
 * dependency for access tokens, and it is all that service account auth needs.
 */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const VOICES_URL = 'https://texttospeech.googleapis.com/v1/voices';
const SYNTHESIZE_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';

// Read-only would be nicer, but Google publishes no narrower scope for this API.
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * Cached access token. Google issues these for an hour; minting one per request
 * would add a round trip to every generation for nothing.
 *
 * Renewed a minute early so a token cannot expire in flight.
 */
let cached = { token: null, expiresAt: 0 };
const RENEW_MARGIN_MS = 60_000;

async function getAccessToken() {
  if (cached.token && Date.now() < cached.expiresAt - RENEW_MARGIN_MS) {
    return cached.token;
  }

  const issuedAt = Math.floor(Date.now() / 1000);

  // The JWT-bearer flow: we sign a short assertion with the service account's
  // private key, and Google trades it for an access token. The private key never
  // leaves this process.
  const assertion = jwt.sign(
    {
      iss: googleServiceAccount.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3_600,
    },
    googleServiceAccount.private_key,
    { algorithm: 'RS256' },
  );

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload?.access_token) {
    // 'invalid_grant' here almost always means the machine clock is wrong or the
    // key was revoked, so the provider's own wording is worth keeping.
    throw new Error(
      `Google refused the service account credentials (${response.status}): ${
        payload?.error_description ?? payload?.error ?? 'no access token returned'
      }`,
    );
  }

  cached = {
    token: payload.access_token,
    expiresAt: Date.now() + payload.expires_in * 1_000,
  };

  logger.debug('Minted a Google access token', { expiresInSeconds: payload.expires_in });

  return cached.token;
}

async function googleFetch(url, init = {}) {
  const token = await getAccessToken();

  const response = await fetch(url, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const detail = await response.text();

    // A 401/403 usually means the Text-to-Speech API is not enabled on the
    // project, or the key lacks the role - both are setup problems, and Google's
    // message says which.
    throw new Error(`Google Text-to-Speech failed (${response.status}): ${detail.slice(0, 300)}`);
  }

  return response.json();
}

/**
 * Product families, longest first so 'Chirp3-HD' is not matched as 'Chirp'.
 *
 * These are the naming segments Google puts in a voice id. Deliberately a
 * NAMING list and not a pricing one: the tier is what a plan allows and what a
 * cost multiplier is calibrated against, but no rate is implied here. See
 * DECISIONS.md §1.
 */
const TIER_TOKENS = [
  'Chirp3-HD',
  'Chirp-HD',
  'Chirp',
  'Journey',
  'Polyglot',
  'Studio',
  'Neural2',
  'Wavenet',
  'Casual',
  'News',
  'Standard',
];

/** Derives a tier slug from a voice id, e.g. 'en-US-Neural2-F' -> 'neural2'. */
export function tierFromVoiceId(voiceId) {
  const match = TIER_TOKENS.find((token) => voiceId.toLowerCase().includes(token.toLowerCase()));
  return (match ?? 'other').toLowerCase();
}

export async function listVoices() {
  const payload = await googleFetch(VOICES_URL);

  return (payload.voices ?? []).map((voice) => ({
    providerVoiceId: voice.name,
    languageCodes: voice.languageCodes ?? [],
    languageCode: voice.languageCodes?.[0] ?? 'und',
    gender: voice.ssmlGender ?? 'UNSPECIFIED',
    tier: tierFromVoiceId(voice.name),
    naturalSampleRateHertz: voice.naturalSampleRateHertz ?? null,
  }));
}

export async function synthesize({ text, voiceId, languageCode }) {
  const payload = await googleFetch(SYNTHESIZE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      // Both fields: `name` picks the exact voice, and Google still requires a
      // languageCode alongside it.
      voice: { name: voiceId, languageCode },
      audioConfig: { audioEncoding: 'MP3' },
    }),
  });

  if (!payload.audioContent) {
    throw new Error('Google returned no audio content');
  }

  return {
    audio: Buffer.from(payload.audioContent, 'base64'),
    mimeType: 'audio/mpeg',
    encoding: 'MP3',
    extension: 'mp3',
  };
}

// Exported for the boot log, so it is obvious which project is being billed.
export function describe() {
  return `google (${googleServiceAccount?.client_email ?? 'no credentials'})`;
}

export const maxInputBytes = env.TTS_MAX_INPUT_BYTES;
