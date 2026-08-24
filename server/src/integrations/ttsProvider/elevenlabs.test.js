import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';

/**
 * Unit tests for the ElevenLabs adapter, with fetch stubbed.
 *
 * No network and no API key: what is worth testing here is the translation in
 * both directions - our arguments into their request, and their payload into the
 * shape scripts/seed.js and tts.service.js expect. A test that called the real
 * API would need a paid account, would spend credits on every run, and would
 * still not pin down the mapping.
 *
 * The credit path around this adapter is already covered end to end in
 * tts.test.js against the mock provider, and none of it is provider-specific.
 */

// Set before the import: env.js reads process.env at module load, and dotenv does
// not overwrite a value that is already there. This is a fake key - it exists to
// prove which header it ends up in.
const API_KEY = 'xi-test-key-not-a-real-one';
process.env.ELEVENLABS_API_KEY = API_KEY;

let elevenlabs;
const realFetch = global.fetch;

// Every call the adapter made, so the request can be asserted as well as the
// return value.
let calls = [];

before(async () => {
  elevenlabs = await import('./elevenlabs.js');
});

afterEach(() => {
  global.fetch = realFetch;
  calls = [];
});

/** Queues one response per expected call, in order. */
function stubFetch(responses) {
  const queue = [...responses];

  global.fetch = (url, init) => {
    calls.push({ url, init });

    const next = queue.shift();

    if (!next) throw new Error(`Unexpected extra fetch to ${url}`);

    return Promise.resolve(next);
  };
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function audioResponse(bytes) {
  const buffer = Buffer.from(bytes);

  return {
    ok: true,
    status: 200,
    arrayBuffer: () => Promise.resolve(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)),
  };
}

function errorResponse(status, body) {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

describe('elevenlabs.synthesize', () => {
  it('posts the text and returns the audio as an mp3 buffer', async () => {
    stubFetch([audioResponse([0xff, 0xfb, 0x90, 0x00])]);

    const result = await elevenlabs.synthesize({
      text: 'Hello from the test suite.',
      voiceId: '21m00Tcm4TlvDq8ikWAM',
      // Passed by the dispatcher and deliberately unused: multilingual_v2 infers
      // the language from the text.
      languageCode: 'en-US',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, 'POST');
    assert.match(calls[0].url, /\/v1\/text-to-speech\/21m00Tcm4TlvDq8ikWAM\?/);
    assert.match(calls[0].url, /output_format=mp3_44100_128/);

    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.text, 'Hello from the test suite.');
    assert.equal(body.model_id, 'eleven_multilingual_v2');

    // The shape tts.service.js stores and serves back.
    assert.ok(Buffer.isBuffer(result.audio));
    assert.equal(result.audio.byteLength, 4);
    assert.equal(result.mimeType, 'audio/mpeg');
    assert.equal(result.encoding, 'MP3');
    assert.equal(result.extension, 'mp3');
  });

  it('sends the key in the xi-api-key header and never in the URL', async () => {
    stubFetch([audioResponse([0x00])]);

    await elevenlabs.synthesize({ text: 'Hi.', voiceId: 'abc123' });

    assert.equal(calls[0].init.headers['xi-api-key'], API_KEY);
    // A key in a query string ends up in access logs and proxy caches on the way.
    assert.ok(!calls[0].url.includes(API_KEY), 'the API key leaked into the URL');
  });

  it('throws on an empty audio body rather than storing a zero-byte file', async () => {
    stubFetch([audioResponse([])]);

    await assert.rejects(
      elevenlabs.synthesize({ text: 'Hi.', voiceId: 'abc123' }),
      /empty audio body/,
    );
  });

  /**
   * The failure contract: a throw. tts.service.js turns any throw from here into
   * a refund plus a 502, so what matters is that a provider error never resolves
   * successfully - and that the message says enough to fix it.
   */
  it('throws with the provider message and a hint when the key is rejected', async () => {
    stubFetch([errorResponse(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } })]);

    await assert.rejects(elevenlabs.synthesize({ text: 'Hi.', voiceId: 'abc123' }), (error) => {
      assert.match(error.message, /401/);
      assert.match(error.message, /ELEVENLABS_API_KEY/);
      assert.match(error.message, /Invalid API key/);
      return true;
    });
  });

  it('flattens a validation error, whose detail is an array', async () => {
    stubFetch([
      errorResponse(422, { detail: [{ loc: ['body', 'text'], msg: 'field required' }] }),
    ]);

    await assert.rejects(
      elevenlabs.synthesize({ text: '', voiceId: 'abc123' }),
      /422.*field required/s,
    );
  });

  it('still throws when the error body is not JSON', async () => {
    stubFetch([errorResponse(502, '<html>Bad Gateway</html>')]);

    await assert.rejects(elevenlabs.synthesize({ text: 'Hi.', voiceId: 'abc123' }), /502/);
  });
});

describe('elevenlabs.listVoices', () => {
  it('normalises a voice into the shape the seeder writes', async () => {
    stubFetch([
      jsonResponse({
        voices: [
          {
            voice_id: '21m00Tcm4TlvDq8ikWAM',
            name: 'Rachel',
            category: 'premade',
            labels: { gender: 'female', accent: 'american' },
            verified_languages: [
              { language: 'en', locale: 'en-US', model_id: 'eleven_multilingual_v2' },
              { language: 'hi', locale: 'hi-IN', model_id: 'eleven_multilingual_v2' },
            ],
          },
        ],
        has_more: false,
      }),
    ]);

    const voices = await elevenlabs.listVoices();

    assert.equal(voices.length, 1);
    assert.deepEqual(voices[0], {
      providerVoiceId: '21m00Tcm4TlvDq8ikWAM',
      // Sent because the id is not readable; seed.js uses it as the display name.
      name: 'Rachel',
      languageCode: 'en-US',
      // Every language the voice is verified for, kept even though the picker
      // groups by the one above.
      languageCodes: ['en-US', 'hi-IN'],
      gender: 'FEMALE',
      tier: 'premade',
      naturalSampleRateHertz: 44_100,
    });
  });

  it('falls back to the accent when no language is verified, and to en when neither is', async () => {
    stubFetch([
      jsonResponse({
        voices: [
          { voice_id: 'a', name: 'A', category: 'cloned', labels: { accent: 'british' } },
          { voice_id: 'b', name: 'B', category: 'nonsense', labels: {} },
        ],
        has_more: false,
      }),
    ]);

    const voices = await elevenlabs.listVoices();

    assert.equal(voices[0].languageCode, 'en-GB');
    assert.equal(voices[0].gender, 'UNSPECIFIED');
    assert.equal(voices[1].languageCode, 'en');
    // A category we do not recognise must not become a tier a plan might gate on.
    assert.equal(voices[1].tier, 'other');
  });

  it('follows pagination and drops an entry with no id', async () => {
    stubFetch([
      jsonResponse({
        voices: [{ voice_id: 'first', name: 'First', category: 'premade' }],
        has_more: true,
        next_page_token: 'page-2',
      }),
      jsonResponse({
        voices: [{ name: 'No id at all' }, { voice_id: 'second', name: 'Second' }],
        has_more: false,
      }),
    ]);

    const voices = await elevenlabs.listVoices();

    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /next_page_token=page-2/);

    // An id-less entry would be upserted on an undefined key, and an upsert does
    // not run Mongoose's `required` validators - so it has to be dropped here.
    assert.deepEqual(
      voices.map((voice) => voice.providerVoiceId),
      ['first', 'second'],
    );
  });
});

describe('elevenlabs.describe', () => {
  it('reports the model and that a key is set, without printing it', () => {
    const line = elevenlabs.describe();

    assert.match(line, /elevenlabs/);
    assert.match(line, /eleven_multilingual_v2/);
    assert.ok(!line.includes(API_KEY), 'the boot log printed the API key');
  });
});
