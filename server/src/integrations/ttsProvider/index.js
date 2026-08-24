import { env } from '../../config/env.js';

import * as elevenlabs from './elevenlabs.js';
import * as google from './google.js';
import * as mock from './mock.js';

/**
 * The only way the rest of the codebase reaches a text-to-speech provider.
 *
 * Same shape as integrations/email: transports chosen by one env var, so the
 * services above this file never learn which one is live.
 *
 *   mock       - generates a placeholder tone locally. Needs no provider account,
 *                no billing and no network, so every part of the credit path can
 *                be built and tested first.
 *   google     - Google Cloud Text-to-Speech over its REST API.
 *   elevenlabs - ElevenLabs over its REST API. Development and testing for now.
 *
 * Adding Azure means one more module here and one more enum value in
 * config/env.js. Nothing else changes.
 */
const PROVIDERS = { google, elevenlabs, mock };

/**
 * Always mock under `node --test`, whatever .env says.
 *
 * Without this, `npm test` calls whichever provider the developer happens to have
 * configured: it bills a real account for every generation in the suite, and it
 * fails anyway, because the fixtures use Google-style voice ids that mean nothing
 * to another provider. An automated test run must not be able to spend money.
 *
 * NODE_TEST_CONTEXT is set by the test runner in every worker, and is a more
 * reliable signal than NODE_ENV - `npm test` does not set NODE_ENV, and setting it
 * in the script is not portable across shells. Same reasoning, and the same
 * variable, as middleware/rateLimit.js.
 *
 * An adapter's own tests import the adapter module directly, so this does not put
 * any provider beyond testing - see elevenlabs.test.js.
 */
const requested = process.env.NODE_TEST_CONTEXT ? 'mock' : env.TTS_PROVIDER;

// The enum in config/env.js is what actually constrains this, so the fallback is
// only for the case where a provider is added there and forgotten here. Resolved
// to a name first rather than straight to a module, so `providerName` below can
// never disagree with the module that produced the audio.
const selected = requested in PROVIDERS ? requested : 'mock';
const provider = PROVIDERS[selected];

/**
 * The provider's catalog, normalised.
 *
 * Every entry has: providerVoiceId, languageCode, languageCodes, gender, tier,
 * naturalSampleRateHertz, and optionally `name` for providers whose ids are not
 * readable (seed.js falls back to the id). Notably absent: any price. What a
 * voice costs is a multiplier stored on the Voice document and calibrated by us -
 * see DECISIONS.md §1.
 */
export function listVoices() {
  return provider.listVoices();
}

/**
 * Turns text into audio.
 *
 * Returns { audio: Buffer, mimeType, encoding, extension }. The extension is
 * there so the storage adapter can name the file something a browser will play
 * on download; the mimeType is what gets served back.
 *
 * Throws on provider failure. Callers must treat a throw as "the user was
 * charged and has nothing to show for it" and refund - see tts.service.js.
 */
export function synthesize({ text, voiceId, languageCode }) {
  return provider.synthesize({ text, voiceId, languageCode });
}

/** One line for the boot log, so which provider is live is never a guess. */
export function describe() {
  return provider.describe();
}

// Enforced in the request validator rather than here, so an over-long input is
// rejected before a Generation row or a credit reserve exists.
export const maxInputBytes = env.TTS_MAX_INPUT_BYTES;

// `selected`, not env.TTS_PROVIDER: this name is written into the Generation
// snapshot and into Voice.provider, so under `node --test` it has to say the
// provider that actually produced the audio rather than the one .env asks for.
export const providerName = selected;
