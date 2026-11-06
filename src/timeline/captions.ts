import {
  type Anchor,
  type Composition,
  clipEndSec,
  type MediaClip,
  makeClipId,
  type TextStyle,
} from './composition.js';
import { type CompositionOp, textClip, videoTrack } from './ops.js';
import { type ClipWord, clipWords, NoTranscriptError, type Transcript } from './transcript.js';

/**
 * Captions from a stored transcript: the spoken words grouped into short
 * phrases (or one word at a time), each a text clip on a caption track above
 * the picture, timed to the speech. Export burns them in. Making captions
 * replaces the ones already there, so running it again after an edit brings
 * them back in line with the speech.
 */

export const DEFAULT_CAPTION_TRACK = 'captions';
export const DEFAULT_CAPTION_WORDS = 7;

/** Widest caption, in Latin characters (a CJK character counts as two). */
const MAX_CAPTION_WIDTH = 32;
/** A pause this long between words starts a new caption. */
const PAUSE_SEC = 0.7;
/** How long a caption stays up after its last word, unless the next one starts. */
const HOLD_SEC = 0.4;
/** Shortest caption shown. */
const MIN_CAPTION_SEC = 0.3;

export interface CaptionRequest {
  /** Caption this media clip only; default every transcribed media clip. */
  clipId?: string;
  /** The transcript the caller read, refused if it changed (with `clipId`). */
  transcriptId?: string;
  /** Most words on screen at once; 1 shows one word at a time. */
  maxWords?: number;
  /** Caption track id. */
  track?: string;
  style?: Partial<TextStyle>;
}

/** A clip's source transcript, as stored (never transcribed here). */
export type TranscriptLookup = (
  clipId: string,
  transcriptId?: string,
) => Promise<{ clip: MediaClip; transcript: Transcript }>;

export interface CaptionPlan {
  ops: CompositionOp[];
  /** Captions written. */
  captions: number;
  /** Media clips captioned. */
  clipIds: string[];
  track: string;
}

/** Thrown when captions can't be made (no transcript, a bad caption track). */
export class CaptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptionError';
  }
}

export interface CaptionCue {
  text: string;
  startSec: number;
  endSec: number;
}

/**
 * Plan the caption edit: remove the captions it replaces (all of the caption
 * track, or those over `clipId`), then add one text clip per caption. One
 * batch, so one undo restores the old captions.
 */
export async function planCaptions(
  comp: Composition,
  request: CaptionRequest,
  transcriptFor: TranscriptLookup,
  mintId: () => string = makeClipId,
): Promise<CaptionPlan> {
  const trackId = request.track ?? DEFAULT_CAPTION_TRACK;
  const maxWords = request.maxWords ?? DEFAULT_CAPTION_WORDS;
  const track = comp.tracks.find((t) => t.id === trackId);
  if (track && (track.kind !== 'video' || track.clips.some((c) => c.kind !== 'text'))) {
    throw new CaptionError(
      `Track "${trackId}" holds ${track.kind === 'video' ? 'video' : 'audio'}, not just text; captions need a track of their own. Pick another track.`,
    );
  }

  const sources = request.clipId
    ? [await transcriptFor(request.clipId, request.transcriptId)]
    : await everyTranscribedClip(comp, trackId, transcriptFor);

  const covered = (startSec: number, endSec: number): boolean =>
    !request.clipId ||
    sources.some(({ clip }) => startSec < clipEndSec(clip) && endSec > clip.startSec);
  const removed: CompositionOp[] = (track?.clips ?? [])
    .filter((c) => covered(c.startSec, clipEndSec(c)))
    .map((c) => ({ op: 'removeClip', clipId: c.id }));

  const style = { ...defaultCaptionStyle(comp), ...request.style };
  const added: CompositionOp[] = sources.flatMap(({ clip, transcript }) =>
    groupCaptions(clipWords(transcript, clip), clipEndSec(clip), maxWords).map(
      (cue): CompositionOp => ({
        op: 'addClip',
        trackId,
        clip: textClip({
          id: mintId(),
          text: cue.text,
          startSec: cue.startSec,
          durationSec: roundMs(cue.endSec - cue.startSec),
          style,
        }),
      }),
    ),
  );

  // The caption track goes on top, so the picture can't hide it.
  const addTrack: CompositionOp[] = track
    ? []
    : [{ op: 'addTrack', track: videoTrack({ id: trackId }) }];
  return {
    ops: added.length > 0 || removed.length > 0 ? [...addTrack, ...removed, ...added] : [],
    captions: added.length,
    clipIds: sources.map(({ clip }) => clip.id),
    track: trackId,
  };
}

/** Every media clip outside the caption track whose source has a transcript.
 *  Clips of the same source share one lookup. */
async function everyTranscribedClip(
  comp: Composition,
  captionTrack: string,
  transcriptFor: TranscriptLookup,
): Promise<{ clip: MediaClip; transcript: Transcript }[]> {
  const clips = comp.tracks
    .filter((t) => t.id !== captionTrack && t.kind === 'video')
    .flatMap((t) => t.clips)
    .filter((c): c is MediaClip => c.kind === 'media')
    .sort((a, b) => a.startSec - b.startSec);
  const bySource = new Map<string, Transcript | null>();
  const found: { clip: MediaClip; transcript: Transcript }[] = [];
  for (const clip of clips) {
    let transcript = bySource.get(clip.mediaId);
    if (transcript === undefined) {
      try {
        transcript = (await transcriptFor(clip.id)).transcript;
      } catch (err) {
        if (!(err instanceof NoTranscriptError)) throw err;
        transcript = null;
      }
      bySource.set(clip.mediaId, transcript);
    }
    if (transcript) found.push({ clip, transcript });
  }
  if (found.length === 0) {
    throw new CaptionError(
      'No clip has a transcript yet. Transcribe one first (`clip timeline transcribe` or timeline_transcript).',
    );
  }
  return found;
}

/** Captions sized to the canvas: white on a dark box, near the bottom. */
export function defaultCaptionStyle(comp: Composition): TextStyle {
  return {
    fontSize: Math.round(Math.min(comp.width, comp.height) / 20),
    color: 'white',
    background: 'black@0.6',
    anchor: 'bottom-center' satisfies Anchor,
  };
}

/**
 * Group a clip's words (timeline times) into captions: a new one starts after
 * `maxWords` words, past the width limit, after a pause, or after a sentence
 * ends. Each stays up a moment after its last word, but never into the next
 * one or past `endSec`.
 */
export function groupCaptions(words: ClipWord[], endSec: number, maxWords: number): CaptionCue[] {
  const groups: ClipWord[][] = [];
  let current: ClipWord[] = [];
  for (const word of words) {
    const prev = current[current.length - 1];
    if (
      prev &&
      (current.length >= maxWords ||
        word.startSec - prev.endSec > PAUSE_SEC ||
        endsSentence(prev.text) ||
        displayWidth(joinWords([...current, word].map((w) => w.text))) > MAX_CAPTION_WIDTH)
    ) {
      groups.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length > 0) groups.push(current);

  const cues: CaptionCue[] = [];
  groups.forEach((group, i) => {
    const first = group[0];
    const last = group[group.length - 1];
    if (!first || !last) return;
    const limit = Math.min(groups[i + 1]?.[0]?.startSec ?? endSec, endSec);
    const end = Math.min(Math.max(last.endSec + HOLD_SEC, first.startSec + MIN_CAPTION_SEC), limit);
    if (end - first.startSec < 0.001) return;
    cues.push({
      text: joinWords(group.map((w) => w.text)),
      startSec: roundMs(first.startSec),
      // Down, so a clip that ends between milliseconds still holds its caption.
      endSec: floorMs(end),
    });
  });
  return cues;
}

const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const CLOSING_PUNCTUATION = /^[,.!?;:%)\]}。，、！？：；）」』]/u;

/** Join words with spaces, except between Chinese/Japanese characters (written
 *  without them) and before closing punctuation. */
export function joinWords(texts: string[]): string {
  let out = '';
  for (const text of texts) {
    const before = out.slice(-1);
    const glued =
      out === '' ||
      CLOSING_PUNCTUATION.test(text) ||
      (NO_SPACE_SCRIPT.test(before) && NO_SPACE_SCRIPT.test(text.charAt(0)));
    out += glued ? text : ` ${text}`;
  }
  return out;
}

function endsSentence(text: string): boolean {
  return /[.!?。！？…]["')\]」』]?$/u.test(text);
}

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]/u;

/** Width in Latin characters: East Asian characters are drawn about twice as wide. */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += WIDE.test(ch) ? 2 : 1;
  return width;
}

function roundMs(sec: number): number {
  return Math.round(sec * 1000) / 1000;
}

function floorMs(sec: number): number {
  return Math.floor(sec * 1000 + 1e-6) / 1000;
}
