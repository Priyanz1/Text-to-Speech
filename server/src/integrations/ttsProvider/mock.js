/**
 * A stand-in for Google Cloud Text-to-Speech that never leaves the machine.
 *
 * This is the same idea as EMAIL_PROVIDER=log: the interesting parts of this
 * feature are the credit reserve, the atomic deduction, the refund on failure
 * and the audio round trip to the browser, and none of them need a billing
 * account to build or to test. It returns a real, playable WAV so the player and
 * the download button are exercised for real rather than mocked out.
 *
 * It is obviously not speech - it is a two-tone chime - which is the point. A
 * mock that sounded like the real thing would be one you could ship by accident.
 */
const SAMPLE_RATE = 16_000;

// Roughly the pace of read-aloud English, used only to make the placeholder
// audio a plausible length for the text. Capped so a long input cannot produce a
// multi-megabyte file.
const CHARS_PER_SECOND = 15;
const MAX_SECONDS = 12;

function buildWav(samples) {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');

  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // subchunk size
  buffer.writeUInt16LE(1, 20); // 1 = uncompressed PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample

  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  for (const [index, sample] of samples.entries()) {
    buffer.writeInt16LE(sample, 44 + index * 2);
  }

  return buffer;
}

/** Two alternating tones with a short fade, so it is audible but clearly not speech. */
function buildTone(seconds) {
  const total = Math.floor(seconds * SAMPLE_RATE);
  const samples = new Int16Array(total);

  for (let index = 0; index < total; index += 1) {
    const time = index / SAMPLE_RATE;
    const frequency = Math.floor(time * 2) % 2 === 0 ? 440 : 554.37;

    // Fade the last quarter second out, otherwise the file ends on a click.
    const remaining = (total - index) / SAMPLE_RATE;
    const gain = 0.25 * Math.min(1, remaining * 4);

    samples[index] = Math.round(Math.sin(2 * Math.PI * frequency * time) * gain * 32_767);
  }

  return samples;
}

/**
 * A small catalog spanning several languages, so the language and voice pickers
 * have something real to do. The ids follow Google's naming so the tier
 * derivation is exercised too.
 */
const MOCK_VOICES = [
  { providerVoiceId: 'en-US-Neural2-F', languageCode: 'en-US', gender: 'FEMALE', tier: 'neural2' },
  { providerVoiceId: 'en-US-Neural2-D', languageCode: 'en-US', gender: 'MALE', tier: 'neural2' },
  { providerVoiceId: 'en-US-Standard-C', languageCode: 'en-US', gender: 'FEMALE', tier: 'standard' },
  { providerVoiceId: 'en-US-Studio-O', languageCode: 'en-US', gender: 'FEMALE', tier: 'studio' },
  { providerVoiceId: 'en-GB-Neural2-A', languageCode: 'en-GB', gender: 'FEMALE', tier: 'neural2' },
  { providerVoiceId: 'en-GB-Wavenet-B', languageCode: 'en-GB', gender: 'MALE', tier: 'wavenet' },
  { providerVoiceId: 'en-IN-Neural2-A', languageCode: 'en-IN', gender: 'FEMALE', tier: 'neural2' },
  { providerVoiceId: 'en-IN-Standard-B', languageCode: 'en-IN', gender: 'MALE', tier: 'standard' },
  { providerVoiceId: 'hi-IN-Neural2-A', languageCode: 'hi-IN', gender: 'FEMALE', tier: 'neural2' },
  { providerVoiceId: 'hi-IN-Wavenet-C', languageCode: 'hi-IN', gender: 'MALE', tier: 'wavenet' },
  { providerVoiceId: 'es-ES-Neural2-A', languageCode: 'es-ES', gender: 'FEMALE', tier: 'neural2' },
  { providerVoiceId: 'fr-FR-Neural2-B', languageCode: 'fr-FR', gender: 'MALE', tier: 'neural2' },
  { providerVoiceId: 'de-DE-Standard-A', languageCode: 'de-DE', gender: 'FEMALE', tier: 'standard' },
  { providerVoiceId: 'ja-JP-Neural2-B', languageCode: 'ja-JP', gender: 'FEMALE', tier: 'neural2' },
];

export function listVoices() {
  return Promise.resolve(
    MOCK_VOICES.map((voice) => ({
      ...voice,
      languageCodes: [voice.languageCode],
      naturalSampleRateHertz: SAMPLE_RATE,
    })),
  );
}

export function synthesize({ text }) {
  const seconds = Math.max(1, Math.min(MAX_SECONDS, text.length / CHARS_PER_SECOND));

  return Promise.resolve({
    audio: buildWav(buildTone(seconds)),
    mimeType: 'audio/wav',
    encoding: 'LINEAR16',
    extension: 'wav',
  });
}

export function describe() {
  return 'mock (no provider call, generates a placeholder tone)';
}
