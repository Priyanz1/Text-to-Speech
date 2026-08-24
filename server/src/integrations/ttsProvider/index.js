import { env } from '../../config/env.js';

import * as google from './google.js';
import * as mock from './mock.js';

/**
 * The only way the rest of the codebase reaches a text-to-speech provider.
 *
 * Same shape as integrations/email: two transports chosen by one env var, so the
 * services above this file never learn which one is live.
 *
 *   mock    - generates a placeholder tone locally. Needs no Google project, no
 *             billing account and no network, so every part of the credit path
 *             can be built and tested first.
 *   google  - Google Cloud Text-to-Speech over its REST API.
 *
 * Adding ElevenLabs or Azure means one more module here and one more enum value
 * in config/env.js. Nothing else changes.
 */
const provider = env.TTS_PROVIDER === 'google' ? google : mock;

/**
 * The provider's catalog, normalised.
 *
 * Every entry has: providerVoiceId, languageCode, languageCodes, gender, tier,
 * naturalSampleRateHertz. Notably absent: any price. What a voice costs is a
 * multiplier stored on the Voice document and calibrated by us - see
 * DECISIONS.md §1.
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

export const providerName = env.TTS_PROVIDER;
