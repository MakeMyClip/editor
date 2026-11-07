import { useCallback, useEffect, useRef, useState } from 'react';
import type { Verb } from '../lib/verbs.js';
import type { MediaClip } from '../types.js';

/** Mirrors ClipTranscript in src/timeline/transcript.ts. */
interface ClipWord {
  index: number;
  text: string;
  startSec: number;
  endSec: number;
}

interface ClipTranscript {
  words: ClipWord[];
  retakes: { fromIndex: number; toIndex: number; text: string }[];
  transcriptId: string;
}

/**
 * Edit a media clip by its words: transcribe on request (the local whisper.cpp
 * is optional, so its setup message shows here when it's missing), click a word
 * to move the playhead, shift-click to select a range, then cut it. Phrases
 * said twice in a row are marked and can all be cut at once. Every cut is one
 * undoable edit through the verb layer.
 */
export function TranscriptSection({
  clip,
  busy,
  onApply,
  onSeek,
}: {
  clip: MediaClip;
  busy: boolean;
  onApply: (verbs: Verb[]) => Promise<number | null>;
  onSeek: (sec: number) => void;
}) {
  const [transcript, setTranscript] = useState<ClipTranscript | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  // Set once the transcript has been asked for; `latest` numbers requests so a
  // response for an older clip window is dropped instead of shown.
  const wanted = useRef(false);
  const latest = useRef(0);

  const load = useCallback(async () => {
    wanted.current = true;
    const request = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/timeline/transcript/${encodeURIComponent(clip.id)}`);
      const json = (await res.json()) as ClipTranscript & { error?: string };
      if (request !== latest.current) return;
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setTranscript(json);
    } catch (err) {
      if (request === latest.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [clip.id]);

  // A cut or trim changes the clip's window: reload a transcript that was asked
  // for, even one still loading (its response is then dropped as outdated). The
  // old words' times and indices no longer match, so they go until it's back.
  const windowKey = `${clip.startSec}:${clip.sourceInSec}:${clip.sourceOutSec}`;
  useEffect(() => {
    if (windowKey && wanted.current) {
      setTranscript(null);
      setAnchor(null);
      setFocus(null);
      void load();
    }
  }, [windowKey, load]);

  const from = anchor !== null && focus !== null ? Math.min(anchor, focus) : null;
  const to = anchor !== null && focus !== null ? Math.max(anchor, focus) : null;
  const words = transcript?.words ?? [];
  const retakes = transcript?.retakes ?? [];
  const selectedCount =
    from === null || to === null ? 0 : words.filter((w) => w.index >= from && w.index <= to).length;
  const inRetake = (index: number): boolean =>
    retakes.some((r) => index >= r.fromIndex && index <= r.toIndex);

  return (
    <div className="ci-section">
      <div className="ci-section-title">Transcript</div>
      {error ? <div className="form-error">{error}</div> : null}
      {transcript === null ? (
        <>
          <p className="form-hint">
            Transcribe this clip to cut it by its words. The first time takes a while.
          </p>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || loading}
            onClick={() => void load()}
          >
            {loading ? 'Transcribing…' : 'Show transcript'}
          </button>
        </>
      ) : words.length === 0 ? (
        <p className="form-hint">No speech found in this clip.</p>
      ) : (
        <>
          <div className="ci-transcript">
            {words.map((w) => {
              const selected = from !== null && to !== null && w.index >= from && w.index <= to;
              const cls = `ci-word${selected ? ' is-selected' : inRetake(w.index) ? ' is-retake' : ''}`;
              return (
                <button
                  type="button"
                  key={w.index}
                  className={cls}
                  title={`${w.startSec.toFixed(2)}s`}
                  onClick={(e) => {
                    if (e.shiftKey && anchor !== null) {
                      setFocus(w.index);
                    } else {
                      setAnchor(w.index);
                      setFocus(w.index);
                    }
                    onSeek(w.startSec);
                  }}
                >
                  {w.text}
                </button>
              );
            })}
          </div>
          {retakes.length > 0 ? (
            <p className="ci-retake-note">
              {retakes.length === 1 ? '1 repeated take' : `${retakes.length} repeated takes`} found:
              “{retakes[0]?.text}”
            </p>
          ) : null}
          <div className="ci-transcript-actions">
            <button
              type="button"
              className="btn-primary"
              disabled={busy || loading || from === null || to === null}
              onClick={async () => {
                if (from === null || to === null) return;
                const applied = await onApply([
                  {
                    verb: 'cut_words',
                    clipId: clip.id,
                    fromIndex: from,
                    toIndex: to,
                    transcriptId: transcript.transcriptId,
                  },
                ]);
                if (applied !== null) {
                  setAnchor(null);
                  setFocus(null);
                }
              }}
            >
              {selectedCount > 0
                ? `Cut ${selectedCount} selected word${selectedCount === 1 ? '' : 's'}`
                : 'Cut selected words'}
            </button>
            {retakes.length > 0 ? (
              <button
                type="button"
                className="btn-secondary"
                disabled={busy || loading}
                onClick={() =>
                  void onApply([
                    {
                      verb: 'remove_retakes',
                      clipId: clip.id,
                      transcriptId: transcript.transcriptId,
                    },
                  ])
                }
              >
                Remove repeated takes
              </button>
            ) : null}
          </div>
          <p className="form-hint">
            Click a word to move the playhead; shift-click to select a range. Undo restores.
          </p>
        </>
      )}
    </div>
  );
}
