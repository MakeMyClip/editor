import { useState } from 'react';
import { clipDuration, clipEndSec, clipLabel } from '../lib/composition.js';
import type { Verb } from '../lib/verbs.js';
import type { Clip } from '../types.js';

const TRANSITION_KINDS = [
  'fade',
  'fadeblack',
  'fadewhite',
  'dissolve',
  'wipeleft',
  'wiperight',
  'wipeup',
  'wipedown',
  'slideleft',
  'slideright',
  'circleopen',
  'circleclose',
];

function num(value: string): number | undefined {
  const n = Number(value);
  return value.trim() === '' || Number.isNaN(n) ? undefined : n;
}

/**
 * Edit a selected clip by emitting verbs through the shared verb layer (the same
 * path the agent + CLI use). Numeric trim/move, split at the playhead, add a
 * transition into the next clip, remove. `set_transform` is intentionally absent
 * — the compiler rejects a non-identity transform, so the UI must not author one.
 * Remounted per clip (keyed by id) so the inputs reset to the selected clip.
 */
export function ClipInspector({
  clip,
  playheadSec,
  hasNext,
  busy,
  error,
  onApply,
  onClose,
}: {
  clip: Clip;
  playheadSec: number;
  hasNext: boolean;
  busy: boolean;
  error: string | null;
  onApply: (verbs: Verb[]) => void;
  onClose: () => void;
}) {
  const isMedia = clip.kind === 'media';
  const [inSec, setInSec] = useState(isMedia ? String(clip.sourceInSec) : '');
  const [outSec, setOutSec] = useState(isMedia ? String(clip.sourceOutSec) : '');
  const [startSec, setStartSec] = useState(String(clip.startSec));
  const [trKind, setTrKind] = useState('fade');
  const [trDur, setTrDur] = useState('0.5');

  const start = clip.startSec;
  const end = clipEndSec(clip);
  const playheadInside = playheadSec > start && playheadSec < end;

  return (
    <section className="detail clip-inspector">
      <div className="ci-head">
        <div>
          <h2>{clipLabel(clip)}</h2>
          <div className="id">
            {clip.kind} · {clip.id} · {start.toFixed(2)}–{end.toFixed(2)}s (
            {clipDuration(clip).toFixed(2)}s)
          </div>
        </div>
        <button type="button" className="btn-secondary" onClick={onClose}>
          Done
        </button>
      </div>

      {error ? <div className="form-error">{error}</div> : null}

      {isMedia ? (
        <div className="ci-section">
          <div className="ci-section-title">Trim (source window)</div>
          <div className="form-row">
            <label className="form-field">
              <span className="form-field-label">In (s)</span>
              <input
                className="form-input"
                value={inSec}
                onChange={(e) => setInSec(e.target.value)}
                inputMode="decimal"
              />
            </label>
            <label className="form-field">
              <span className="form-field-label">Out (s)</span>
              <input
                className="form-input"
                value={outSec}
                onChange={(e) => setOutSec(e.target.value)}
                inputMode="decimal"
              />
            </label>
          </div>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() =>
              onApply([
                {
                  verb: 'trim',
                  clipId: clip.id,
                  sourceInSec: num(inSec),
                  sourceOutSec: num(outSec),
                },
              ])
            }
          >
            Apply trim
          </button>
        </div>
      ) : null}

      <div className="ci-section">
        <div className="ci-section-title">Position</div>
        <label className="form-field">
          <span className="form-field-label">Start on timeline (s)</span>
          <input
            className="form-input"
            value={startSec}
            onChange={(e) => setStartSec(e.target.value)}
            inputMode="decimal"
          />
        </label>
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={() => onApply([{ verb: 'move', clipId: clip.id, startSec: num(startSec) }])}
        >
          Move
        </button>
      </div>

      <div className="ci-section">
        <div className="ci-section-title">Split</div>
        <p className="form-hint">
          Cut this clip in two at the playhead ({playheadSec.toFixed(2)}s).
          {playheadInside ? '' : ' Move the playhead inside the clip to enable.'}
        </p>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy || !playheadInside}
          onClick={() => onApply([{ verb: 'split', clipId: clip.id, atSec: playheadSec }])}
        >
          Split at playhead
        </button>
      </div>

      <div className="ci-section">
        <div className="ci-section-title">Transition</div>
        {hasNext ? (
          <>
            <div className="form-row">
              <label className="form-field">
                <span className="form-field-label">Kind</span>
                <select
                  className="form-input"
                  value={trKind}
                  onChange={(e) => setTrKind(e.target.value)}
                >
                  {TRANSITION_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-field">
                <span className="form-field-label">Duration (s)</span>
                <input
                  className="form-input"
                  value={trDur}
                  onChange={(e) => setTrDur(e.target.value)}
                  inputMode="decimal"
                />
              </label>
            </div>
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() =>
                onApply([
                  {
                    verb: 'transition',
                    afterClipId: clip.id,
                    kind: trKind,
                    durationSec: num(trDur),
                  },
                ])
              }
            >
              Add transition into next clip
            </button>
          </>
        ) : (
          <p className="form-hint">No clip follows this one — add one to transition into.</p>
        )}
      </div>

      <div className="ci-section">
        <button
          type="button"
          className="ci-remove"
          disabled={busy}
          onClick={() => onApply([{ verb: 'remove', clipId: clip.id }])}
        >
          Remove clip
        </button>
      </div>
    </section>
  );
}
