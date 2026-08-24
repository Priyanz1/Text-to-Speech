import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * ElevenLabs over its REST API.
 *
 * The same two-function contract as google.js and mock.js - listVoices() and
 * synthesize() - so nothing above integrations/ttsProvider learns which provider
 * is live. Adding this file changes no caller.
 *
 * No SDK. An API key in a header and two fetch calls is less machinery than
 * google.js already needs without one.
 *
 * DEVELOPMENT AND TESTING ONLY for now. Note what this file does NOT do: it does
 * not price anything. A generation is quoted per character from the Voice
 * document's costMultiplier, which seed.js sets to 1 for every voice regardless
 * of provider. Calibrating a multiplier against ElevenLabs' rates is a pricing
 * step with its own decision to record - see DECISIONS.md §1, which is why there
 * is no rate anywhere below.
 */
const BASE_URL = 'https://api.elevenlabs.io';

/**
 * The model that turns text into speech.
 *
 * eleven_multilingual_v2 is the documented default, works on every account tier,
 * and infers the spoken language from the text rather than from a parameter -
 * which is what makes the one-locale-per-voice compromise in normaliseVoice()
 * harmless.
 *
 * A constant and not an env var on purpose: it is a code-level choice about
 * output quality, not a per-deployment secret or a value anyone needs to vary
 * between machines.
 */
const MODEL_ID = 'eleven_multilingual_v2';

/**
 * ElevenLabs names formats codec_samplerate_bitrate. MP3 at 44.1 kHz / 128 kbps
 * is the documented default and is available on the free tier - 192 kbps MP3 and
 * 44.1 kHz PCM both require a paid plan.
 *
 * The sample rate reported in the catalog is read back out of this string rather
 * than written a second time, so the two cannot drift apart.
 */
const OUTPUT_FORMAT = 'mp3_44100_128';
const OUTPUT_SAMPLE_RATE = Number(OUTPUT_FORMAT.split('_')[1]);

// 100 is the documented maximum page size. The page cap is a runaway guard, not
// a product limit: an account holding more than 500 voices is a seeding problem,
// not a catalog worth following to the end.
const VOICES_PAGE_SIZE = 100;
const MAX_VOICE_PAGES = 5;

/**
 * What each failure status actually means, because the status alone is
 * misleading here: a 422 is usually a voice id the account cannot use, and a 429
 * is usually an exhausted quota rather than a rate limit.
 */
const STATUS_HINTS = {
  401: 'the API key was rejected - check ELEVENLABS_API_KEY',
  403: 'this account is not allowed to use that voice or model',
  404: 'no such voice on this account - re-run `npm run seed` after switching provider',
  422: 'the request was rejected as invalid, usually the voice or model id',
  429: 'out of ElevenLabs credits, or too many requests',
};

/**
 * The provider's own words for a failure, flattened to one line.
 *
 * ElevenLabs reports most errors as {detail: {status, message}} and validation
 * failures as {detail: [{loc, msg}]}. Both are handled because the message is
 * the only part that says which of the two happened, and they need different
 * fixes.
 */
function failureDetail(body) {
  try {
    const detail = JSON.parse(body)?.detail;

    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      return detail.map((issue) => issue?.msg ?? JSON.stringify(issue)).join('; ');
    }
    if (detail?.message) return detail.message;
  } catch {
    // Not JSON - a proxy or gateway page. The text itself is the best available
    // description, so fall through.
  }

  return body.slice(0, 300) || 'no error body';
}

/**
 * Every call to ElevenLabs goes through here, and returns the Response rather
 * than a parsed body: the voices endpoint answers with JSON and the synthesize
 * endpoint answers with raw audio.
 *
 * Throws on any non-2xx. tts.service.js treats a throw from synthesize() as
 * "charged and nothing to show for it", logs this message in full and refunds -
 * so the message is written for that log, not for a user.
 */
async function elevenLabsFetch(path, init = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      // The key travels in this header and nowhere else. Never a query
      // parameter, which would put it in every access log and proxy cache along
      // the way, and never anywhere the browser can reach it: the client talks
      // to this API, and this API talks to ElevenLabs.
      'xi-api-key': env.ELEVENLABS_API_KEY,
    },
  });

  if (!response.ok) {
    const hint = STATUS_HINTS[response.status];
    const detail = failureDetail(await response.text().catch(() => ''));

    throw new Error(
      `ElevenLabs request failed (${response.status}${hint ? `, ${hint}` : ''}): ${detail}`,
    );
  }

  return response;
}

/** The categories ElevenLabs publishes. Anything else becomes 'other'. */
const CATEGORIES = ['premade', 'professional', 'cloned', 'generated', 'famous', 'high_quality'];

/**
 * ElevenLabs' `category` as the tier.
 *
 * A tier in this codebase is a naming fact and never a price: plans allow or
 * deny whole tiers, and the cost multiplier per tier is calibrated separately
 * and stored on the Voice document. Nothing here implies a rate - same rule as
 * google.js's TIER_TOKENS.
 */
export function tierFromCategory(category) {
  const value = typeof category === 'string' ? category.trim().toLowerCase() : '';

  return CATEGORIES.includes(value) ? value : 'other';
}

/** labels.gender is free text, so it is mapped rather than trusted. */
function genderFrom(label) {
  switch (typeof label === 'string' ? label.trim().toLowerCase() : '') {
    case 'male':
      return 'MALE';
    case 'female':
      return 'FEMALE';
    case 'neutral':
    case 'non-binary':
      return 'NEUTRAL';
    default:
      return 'UNSPECIFIED';
  }
}

// Enough to turn the common English accents into locales the language picker can
// group by. Deliberately short: it is a display nicety, and the fallback below
// is already correct.
const ACCENT_LOCALES = {
  american: 'en-US',
  british: 'en-GB',
  english: 'en-GB',
  australian: 'en-AU',
  canadian: 'en-CA',
  irish: 'en-IE',
  indian: 'en-IN',
  transatlantic: 'en-US',
};

function localeFromLabels(labels) {
  const accent = typeof labels?.accent === 'string' ? labels.accent.trim().toLowerCase() : '';

  if (ACCENT_LOCALES[accent]) return ACCENT_LOCALES[accent];

  const language = typeof labels?.language === 'string' ? labels.language.trim() : '';

  return language || null;
}

/**
 * One locale per voice, because the catalog is one row per voice.
 *
 * ElevenLabs voices are multilingual: a single voice speaks dozens of languages,
 * and eleven_multilingual_v2 chooses from the text. Our Voice model holds one
 * languageCode per row behind a unique index on (provider, providerVoiceId), so
 * a voice cannot be listed once per language without either breaking that index
 * or inventing rows the provider does not have.
 *
 * So languageCode is only where the voice is PRESENTED in the language picker,
 * and every language ElevenLabs verifies for it is kept in languageCodes. Hindi
 * text sent to a voice presented under en-US still comes back as Hindi speech -
 * the picker groups, the model decides.
 */
function normaliseVoice(voice) {
  const verified = Array.isArray(voice.verified_languages) ? voice.verified_languages : [];

  // locale ('en-US') in preference to language ('en'), deduplicated: several
  // entries can differ only by model_id.
  const languageCodes = [
    ...new Set(verified.map((entry) => entry?.locale || entry?.language).filter(Boolean)),
  ];

  const primary =
    languageCodes[0] ?? localeFromLabels(voice.labels) ?? voice.fine_tuning?.language ?? 'en';

  return {
    providerVoiceId: voice.voice_id,

    // Included because an ElevenLabs id is an opaque hash, where google.js and
    // mock.js can let the id double as the label ('en-US-Neural2-F'). seed.js
    // falls back to the id for providers that omit this.
    name: voice.name || voice.voice_id,

    languageCode: primary,
    languageCodes: languageCodes.length > 0 ? languageCodes : [primary],
    gender: genderFrom(voice.labels?.gender),
    tier: tierFromCategory(voice.category),
    naturalSampleRateHertz: OUTPUT_SAMPLE_RATE,
  };
}

/**
 * Every voice available to this account, normalised for scripts/seed.js.
 *
 * /v2/voices is paginated, unlike Google's flat list, so this follows
 * next_page_token until has_more says to stop.
 */
export async function listVoices() {
  const collected = [];
  let pageToken = null;

  for (let page = 0; page < MAX_VOICE_PAGES; page += 1) {
    const query = new URLSearchParams({ page_size: String(VOICES_PAGE_SIZE) });

    if (pageToken) query.set('next_page_token', pageToken);

    const response = await elevenLabsFetch(`/v2/voices?${query.toString()}`);
    const payload = await response.json();

    collected.push(...(payload.voices ?? []));

    if (!payload.has_more || !payload.next_page_token) break;

    pageToken = payload.next_page_token;
  }

  logger.debug('Read the ElevenLabs voice catalog', { voices: collected.length });

  // An entry with no id cannot be stored: the seeder upserts on
  // (provider, providerVoiceId), and an upsert does not run Mongoose's
  // `required` validators - so a malformed entry would be written rather than
  // rejected. Dropped here instead.
  return collected.filter((voice) => voice?.voice_id).map(normaliseVoice);
}

export async function synthesize({ text, voiceId }) {
  const response = await elevenLabsFetch(
    `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${OUTPUT_FORMAT}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No language_code: multilingual_v2 ignores it and infers the language
      // from the text, so sending our presentational locale would look like it
      // controlled something. voice_settings is left off too - the voice's own
      // saved settings are the sensible default.
      body: JSON.stringify({ text, model_id: MODEL_ID }),
    },
  );

  // Raw audio bytes, not base64 inside a JSON envelope. The one place this
  // differs in shape from google.js.
  const audio = Buffer.from(await response.arrayBuffer());

  if (audio.byteLength === 0) {
    throw new Error('ElevenLabs returned an empty audio body');
  }

  return {
    audio,
    mimeType: 'audio/mpeg',
    encoding: 'MP3',
    extension: 'mp3',
  };
}

/**
 * One line for the boot log.
 *
 * Says whether the key is present and never what it is - unlike google.js, whose
 * client_email is an identifier rather than a secret. "Which account is being
 * billed" is not a question a log line gets to answer here.
 */
export function describe() {
  return `elevenlabs (model ${MODEL_ID}, ${OUTPUT_FORMAT}, key ${
    env.ELEVENLABS_API_KEY ? 'set' : 'MISSING'
  })`;
}

export const maxInputBytes = env.TTS_MAX_INPUT_BYTES;
