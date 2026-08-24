import { useEffect, useRef, useState } from 'react';

import { api } from '../../lib/apiClient.js';
import { toFormMessage } from '../../lib/formError.js';
import { useAuth } from '../auth/authContext.js';

/**
 * The text-to-speech form.
 *
 * Two numbers are shown for the same text, because two different limits apply to
 * it: characters are what the generation costs, and UTF-8 bytes are what the
 * speech provider caps. For English they are the same; for Hindi or Japanese the
 * byte count runs two to three times higher, and the byte limit is the one that
 * bites first. Showing only characters would make that rejection look arbitrary.
 *
 * Both limits also come from the server (GET /api/tts/config) rather than being
 * written in here, so the number this form enforces and the number the API
 * enforces cannot drift apart.
 */
const encoder = new TextEncoder();

export function StudioPanel() {
  const { user, setUser } = useAuth();

  const [config, setConfig] = useState(null);
  const [languages, setLanguages] = useState([]);
  const [languageCode, setLanguageCode] = useState('');
  const [voices, setVoices] = useState([]);
  const [voiceId, setVoiceId] = useState('');
  const [text, setText] = useState('');

  const [state, setState] = useState({ status: 'idle', message: '' });
  const [audio, setAudio] = useState(null);

  // The object URL, kept in a ref as well as in state so it can be revoked
  // without the cleanup depending on a re-render having happened.
  const audioUrlRef = useRef(null);

  // --- loading the catalog -------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [configResponse, languagesResponse] = await Promise.all([
          api.get('/api/tts/config'),
          api.get('/api/voices/languages'),
        ]);

        if (cancelled) return;

        setConfig(configResponse.data.config);

        const list = languagesResponse.data.languages;
        setLanguages(list);

        // Default to en-US, then any English, then whatever is first. An empty
        // catalog means the seeder has not been run.
        const preferred =
          list.find((entry) => entry.languageCode === 'en-US') ??
          list.find((entry) => entry.languageCode.startsWith('en')) ??
          list[0];

        setLanguageCode(preferred?.languageCode ?? '');

        if (list.length === 0) {
          setState({
            status: 'failed',
            message: 'No voices are available yet. Run `npm run seed` on the server.',
          });
        }
      } catch (error) {
        if (!cancelled) setState({ status: 'failed', message: toFormMessage(error) });
      }
    }

    // eslint-disable-next-line react/set-state-in-effect
    load();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!languageCode) return undefined;

    let cancelled = false;

    async function loadVoices() {
      try {
        const response = await api.get(`/api/voices?language=${encodeURIComponent(languageCode)}`);
        if (cancelled) return;

        setVoices(response.data.voices);
        setVoiceId(response.data.voices[0]?.voiceId ?? '');
      } catch (error) {
        if (!cancelled) setState({ status: 'failed', message: toFormMessage(error) });
      }
    }

    // eslint-disable-next-line react/set-state-in-effect
    loadVoices();

    return () => {
      cancelled = true;
    };
  }, [languageCode]);

  // Revoke the last object URL when the panel goes away. Without this, every
  // generation in a session leaks its audio for as long as the tab is open.
  useEffect(
    () => () => {
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    },
    [],
  );

  // --- derived numbers -----------------------------------------------------

  const charCount = text.length;
  const byteLength = encoder.encode(text).length;

  const voice = voices.find((entry) => entry.voiceId === voiceId) ?? null;
  const balance = user.credits?.total ?? 0;

  // Mirrors quote() on the server: characters times the voice's multiplier,
  // rounded up. Shown before the button is pressed, because the price should
  // never be a surprise after the fact.
  const cost = charCount === 0 ? 0 : Math.max(1, Math.ceil(charCount * (voice?.costMultiplier ?? 1)));

  const overBytes = config !== null && byteLength > config.maxInputBytes;
  const overChars = config !== null && charCount > config.maxCharsPerRequest;
  const shortOfCredits = cost > balance;

  const isBusy = state.status === 'generating';
  const canGenerate =
    !isBusy && charCount > 0 && voiceId !== '' && !overBytes && !overChars && !shortOfCredits;

  const blocker = overBytes
    ? `Too long for the speech provider: ${byteLength} bytes of ${config.maxInputBytes}. Non-English text uses more than one byte per character.`
    : overChars
      ? `Too long for the ${config.planName} plan: ${charCount} characters of ${config.maxCharsPerRequest}.`
      : shortOfCredits && charCount > 0
        ? `This needs ${cost} credits and you have ${balance}.`
        : '';

  // --- generating ----------------------------------------------------------

  function replaceAudio(blob, generation) {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);

    const url = URL.createObjectURL(blob);
    audioUrlRef.current = url;

    setAudio({
      url,
      filename: `speech-${generation.id}.${generation.mimeType === 'audio/wav' ? 'wav' : 'mp3'}`,
      charCount: generation.charCount,
      creditsCharged: generation.creditsCharged,
      voiceName: generation.voice.name,
    });
  }

  async function handleGenerate(event) {
    event.preventDefault();
    setState({ status: 'generating', message: '' });

    try {
      const response = await api.post('/api/tts', {
        text,
        voiceId,
        // One key per submit. A double-clicked button, or a retry after a dropped
        // connection, reaches the server twice - the key is what makes the second
        // request return the first one's result instead of charging again.
        idempotencyKey: crypto.randomUUID(),
      });

      const { generation, credits } = response.data;

      // Merged from the same response that spent them, so the balance is never
      // stale between a generation and the next page load.
      setUser((previous) => (previous ? { ...previous, credits } : previous));

      // <audio src> cannot send an Authorization header, so the bytes are fetched
      // here and handed to the player as a blob. The alternative would be a
      // public or signed URL for private audio.
      const blob = await api.getBlob(generation.audioUrl);
      replaceAudio(blob, generation);

      setState({ status: 'done', message: '' });
    } catch (error) {
      setState({ status: 'failed', message: toFormMessage(error) });

      // A failure after the charge refunds, which nets to zero - but re-reading
      // beats displaying a balance we are only assuming is still correct.
      try {
        const refreshed = await api.get('/api/credits/balance');
        setUser((previous) => (previous ? { ...previous, credits: refreshed.data.credits } : previous));
      } catch {
        // The generation error is the one worth showing.
      }
    }
  }

  return (
    <section className="card stack">
      <div className="card-head">
        <h2>Text to speech</h2>
        <span className="balance" title="Subscription credits are spent before purchased ones">
          {balance.toLocaleString()} credits
        </span>
      </div>

      <form className="form" onSubmit={handleGenerate}>
        <label htmlFor="tts-text">Text</label>
        <textarea
          id="tts-text"
          rows={6}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Type or paste the text you want spoken."
          disabled={isBusy}
        />

        <div className={`counters${overBytes || overChars ? ' counters-bad' : ''}`}>
          <span>
            {charCount.toLocaleString()}
            {config === null ? '' : ` / ${config.maxCharsPerRequest.toLocaleString()}`} characters
          </span>
          <span>
            {byteLength.toLocaleString()}
            {config === null ? '' : ` / ${config.maxInputBytes.toLocaleString()}`} bytes
          </span>
          <span>{cost.toLocaleString()} credits</span>
        </div>

        <div className="pickers">
          <div>
            <label htmlFor="tts-language">Language</label>
            <select
              id="tts-language"
              value={languageCode}
              onChange={(event) => setLanguageCode(event.target.value)}
              disabled={isBusy || languages.length === 0}
            >
              {languages.map((entry) => (
                <option key={entry.languageCode} value={entry.languageCode}>
                  {entry.languageName} ({entry.voiceCount})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="tts-voice">Voice</label>
            <select
              id="tts-voice"
              value={voiceId}
              onChange={(event) => setVoiceId(event.target.value)}
              disabled={isBusy || voices.length === 0}
            >
              {voices.map((entry) => (
                <option key={entry.voiceId} value={entry.voiceId}>
                  {entry.name} · {entry.gender.toLowerCase()} · {entry.tier}
                </option>
              ))}
            </select>
          </div>
        </div>

        <button type="submit" className="primary" disabled={!canGenerate}>
          {isBusy ? 'Generating…' : `Generate speech${cost > 0 ? ` · ${cost} credits` : ''}`}
        </button>

        {blocker ? <p className="form-hint">{blocker}</p> : null}
        {state.status === 'failed' ? <p className="form-error">{state.message}</p> : null}
      </form>

      {audio === null ? null : (
        <div className="player">
          {/* No caption track, and none is missing: the transcript is the text the
              user just typed, still on screen above the player. */}
          <audio src={audio.url} controls preload="auto" />
          <div className="player-row">
            <span className="form-hint">
              {audio.voiceName} · {audio.charCount.toLocaleString()} characters ·{' '}
              {audio.creditsCharged.toLocaleString()} credits
            </span>
            {/* download on a blob URL: the file never round-trips to the server again. */}
            <a className="download" href={audio.url} download={audio.filename}>
              Download
            </a>
          </div>
        </div>
      )}
    </section>
  );
}
