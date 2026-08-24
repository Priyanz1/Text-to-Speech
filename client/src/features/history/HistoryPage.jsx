import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../../lib/apiClient.js';
import { toFormMessage } from '../../lib/formError.js';
import { useAuth } from '../auth/authContext.js';

/**
 * Past generations, newest first.
 *
 * Three things here are not obvious and are deliberate:
 *
 * 1. The list carries a preview, not the whole text. "Show full text" is what
 *    fetches the rest (GET /api/generations/:id), so a page of twenty rows is not
 *    twenty full submissions nobody reads.
 *
 * 2. Audio is fetched per row, on demand, as a blob. <audio src> cannot send an
 *    Authorization header, and the audio is private, so the bytes come through
 *    apiClient like every other request. Loading all of them on mount would pull
 *    megabytes for rows the user never plays.
 *
 * 3. Deleting is permanent and is not a refund. The credits were spent when the
 *    audio was made; the ledger keeps its rows either way.
 */
const PAGE_SIZE = 10;

const STATUS_LABEL = {
  completed: 'completed',
  pending: 'running',
  failed: 'failed',
};

function formatWhen(value) {
  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
}

export function HistoryPage() {
  const { user } = useAuth();

  const [page, setPage] = useState(1);
  const [list, setList] = useState(null);
  const [state, setState] = useState({ status: 'loading', message: '' });

  // Per row, so one row's failed audio fetch does not blank the page:
  //   { [id]: { audio, fullText, busy, message, confirming } }
  const [rows, setRows] = useState({});

  // Every object URL handed to an <audio> or a download link, so they can all be
  // revoked. Without this each play leaks its audio for as long as the tab lives.
  const urlsRef = useRef(new Map());

  const patchRow = useCallback((id, patch) => {
    setRows((previous) => ({ ...previous, [id]: { ...previous[id], ...patch } }));
  }, []);

  // --- loading -------------------------------------------------------------

  const load = useCallback(async (targetPage, { quiet = false } = {}) => {
    if (!quiet) setState({ status: 'loading', message: '' });

    try {
      const response = await api.get(`/api/generations?page=${targetPage}&limit=${PAGE_SIZE}`);

      setList(response.data);
      setState({ status: 'ready', message: '' });

      return response.data;
    } catch (error) {
      setState({ status: 'failed', message: toFormMessage(error) });
      return null;
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect
    load(page);
  }, [load, page]);

  // Revoke on the way out, not per row: a row can be unmounted by paging away
  // while its blob is still the one the player is holding.
  useEffect(
    () => () => {
      for (const url of urlsRef.current.values()) URL.revokeObjectURL(url);
      urlsRef.current.clear();
    },
    [],
  );

  // --- audio ---------------------------------------------------------------

  /** Fetches the bytes once and keeps the object URL for replays and downloads. */
  async function ensureAudioUrl(row) {
    const existing = urlsRef.current.get(row.id);
    if (existing) return existing;

    const blob = await api.getBlob(row.audioUrl);
    const url = URL.createObjectURL(blob);
    urlsRef.current.set(row.id, url);

    return url;
  }

  async function handlePlay(row) {
    patchRow(row.id, { busy: 'audio', message: '' });

    try {
      const url = await ensureAudioUrl(row);
      patchRow(row.id, { audio: url, busy: null, message: '' });
    } catch (error) {
      // A 410 here is the ordinary case on a free host: local storage sits on an
      // ephemeral disk, so a deploy takes the files and leaves the records.
      patchRow(row.id, { busy: null, message: toFormMessage(error) });
    }
  }

  async function handleDownload(row) {
    patchRow(row.id, { busy: 'download', message: '' });

    try {
      const url = await ensureAudioUrl(row);

      // A real click on a real anchor: the href is a blob URL, so this saves the
      // bytes already in memory instead of asking the server for them again.
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `speech-${row.id}.${row.mimeType === 'audio/wav' ? 'wav' : 'mp3'}`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();

      patchRow(row.id, { busy: null, message: '' });
    } catch (error) {
      patchRow(row.id, { busy: null, message: toFormMessage(error) });
    }
  }

  // --- full text -----------------------------------------------------------

  async function handleShowFullText(row) {
    patchRow(row.id, { busy: 'text', message: '' });

    try {
      const response = await api.get(`/api/generations/${row.id}`);
      patchRow(row.id, { fullText: response.data.generation.text, busy: null });
    } catch (error) {
      patchRow(row.id, { busy: null, message: toFormMessage(error) });
    }
  }

  // --- deleting ------------------------------------------------------------

  async function handleDelete(row) {
    patchRow(row.id, { busy: 'delete', message: '', confirming: false });

    try {
      await api.delete(`/api/generations/${row.id}`);

      const url = urlsRef.current.get(row.id);
      if (url) {
        URL.revokeObjectURL(url);
        urlsRef.current.delete(row.id);
      }

      // Reload rather than splice the row out, so the count, the page and the
      // pager stay honest. Deleting the only row on the last page steps back a
      // page instead of showing an empty one.
      const isLastOnPage = list.generations.length === 1 && page > 1;

      if (isLastOnPage) {
        setPage(page - 1);
      } else {
        await load(page, { quiet: true });
      }
    } catch (error) {
      patchRow(row.id, { busy: null, message: toFormMessage(error) });
    }
  }

  // --- rendering -----------------------------------------------------------

  const balance = user.credits?.total ?? 0;
  const generations = list?.generations ?? [];

  return (
    <main className="shell shell-wide">
      <header className="header header-row">
        <div>
          <h1>History</h1>
          <p className="subtitle">Everything you have generated, newest first.</p>
        </div>
        <div className="header-actions">
          <span className="balance">{balance.toLocaleString()} credits</span>
          <Link className="download" to="/dashboard">
            Back to studio
          </Link>
        </div>
      </header>

      <section className="card stack">
        <div className="card-head">
          <h2>
            Generations
            {state.status === 'ready' && list ? ` · ${list.total.toLocaleString()}` : ''}
          </h2>
          {state.status === 'ready' && list && list.totalPages > 1 ? (
            <span className="form-hint">
              Page {list.page} of {list.totalPages}
            </span>
          ) : null}
        </div>

        {state.status === 'loading' ? <p className="form-note">Loading your history…</p> : null}

        {state.status === 'failed' ? (
          <>
            <p className="form-error">{state.message}</p>
            <button type="button" className="retry" onClick={() => load(page)}>
              Try again
            </button>
          </>
        ) : null}

        {state.status === 'ready' && generations.length === 0 ? (
          <p className="form-note">
            Nothing here yet. <Link to="/dashboard">Generate some speech</Link> and it will show up
            on this page.
          </p>
        ) : null}

        {generations.length > 0 ? (
          <ul className="history">
            {generations.map((row) => {
              const rowState = rows[row.id] ?? {};
              const isBusy = Boolean(rowState.busy);

              return (
                <li key={row.id} className="history-row">
                  <p className="history-text">
                    {rowState.fullText ?? row.textPreview}
                    {row.textTruncated && !rowState.fullText ? '…' : ''}
                  </p>

                  <p className="history-meta">
                    <span>{row.voice.name || 'unknown voice'}</span>
                    <span>{row.voice.languageCode || '—'}</span>
                    <span>{row.creditsCharged.toLocaleString()} credits</span>
                    {row.creditsRefunded > 0 ? (
                      <span className="history-refunded">
                        {row.creditsRefunded.toLocaleString()} refunded
                      </span>
                    ) : null}
                    <span>{formatWhen(row.createdAt)}</span>
                    {row.status === 'completed' ? null : (
                      <span className={row.status === 'failed' ? 'history-bad' : ''}>
                        {STATUS_LABEL[row.status] ?? row.status}
                      </span>
                    )}
                  </p>

                  {rowState.audio ? (
                    <audio className="history-audio" src={rowState.audio} controls preload="auto" />
                  ) : null}

                  <div className="history-actions">
                    {row.audioUrl === null ? (
                      // The record outlived its file: nothing to play or download.
                      <span className="form-hint">Audio is no longer stored.</span>
                    ) : (
                      <>
                        {rowState.audio ? null : (
                          <button type="button" disabled={isBusy} onClick={() => handlePlay(row)}>
                            {rowState.busy === 'audio' ? 'Loading…' : 'Play'}
                          </button>
                        )}
                        <button type="button" disabled={isBusy} onClick={() => handleDownload(row)}>
                          {rowState.busy === 'download' ? 'Preparing…' : 'Download'}
                        </button>
                      </>
                    )}

                    {row.textTruncated && !rowState.fullText ? (
                      <button type="button" disabled={isBusy} onClick={() => handleShowFullText(row)}>
                        {rowState.busy === 'text' ? 'Loading…' : 'Show full text'}
                      </button>
                    ) : null}

                    {rowState.confirming ? (
                      <>
                        <span className="form-hint">Delete permanently?</span>
                        <button
                          type="button"
                          className="danger"
                          disabled={isBusy}
                          onClick={() => handleDelete(row)}
                        >
                          {rowState.busy === 'delete' ? 'Deleting…' : 'Yes, delete'}
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => patchRow(row.id, { confirming: false })}
                        >
                          Keep
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => patchRow(row.id, { confirming: true, message: '' })}
                      >
                        Delete
                      </button>
                    )}
                  </div>

                  {rowState.message ? <p className="form-error">{rowState.message}</p> : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        {state.status === 'ready' && list && list.totalPages > 1 ? (
          <div className="pager">
            <button type="button" disabled={list.page <= 1} onClick={() => setPage(list.page - 1)}>
              ← Newer
            </button>
            <span className="form-hint">
              {list.total.toLocaleString()} generation{list.total === 1 ? '' : 's'}
            </span>
            <button type="button" disabled={!list.hasMore} onClick={() => setPage(list.page + 1)}>
              Older →
            </button>
          </div>
        ) : null}
      </section>

      <footer className="footer">
        Deleting a generation removes its audio for good. It does not return the credits it cost -
        those were spent when the audio was made.
      </footer>
    </main>
  );
}
