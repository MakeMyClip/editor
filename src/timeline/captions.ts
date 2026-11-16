import { TEXT_EDGE_PX, videoLayers } from './compile.js';
import {
  type Anchor,
  type Clip,
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
/** The box drawtext draws behind a caption reaches this far past its text. */
const CAPTION_BOX_PX = 12;
/** Share of a portrait canvas the vertical feeds' overlays cover: the caption,
 *  buttons and progress bar at the bottom, the action column at the sides. */
const PORTRAIT_BOTTOM_SHARE = 0.25;
const PORTRAIT_SIDE_SHARE = 0.14;
/** A pause this long between words starts a new caption, or a new sentence. */
export const PAUSE_SEC = 0.7;
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

  // A clip's captions run from its start to the next clip on its track, so the
  // ones a trim left past its new end are replaced too.
  const spans = sources.map(({ clip }) => ({
    start: clip.startSec,
    end: nextClipStart(comp, clip),
  }));
  const replaced = (c: Clip): boolean =>
    !request.clipId || spans.some((s) => c.startSec < s.end && clipEndSec(c) > s.start);
  const kept = (track?.clips ?? []).filter((c) => !replaced(c));
  const removed = (track?.clips.length ?? 0) - kept.length;

  const style = { ...defaultCaptionStyle(comp), ...request.style };
  const maxWidth = captionWidthBudget(comp, style);
  const added: CompositionOp[] = sources.flatMap(({ clip, transcript }) =>
    groupCaptions(clipWords(transcript, clip), clipEndSec(clip), maxWords, maxWidth).map(
      (cue): CompositionOp => ({
        op: 'addClip',
        trackId,
        clip: textClip({
          id: mintId(),
          text: cue.text,
          startSec: cue.startSec,
          durationSec: roundMs(cue.endSec - cue.startSec),
          style: fitCaptionStyle(cue.text, style, comp),
        }),
      }),
    ),
  );

  // The caption track sits above the picture, so the picture can't hide it; one
  // left under it (the picture moved up a track since) is lifted to the top.
  const { picture } = videoLayers(comp);
  const lift = Boolean(
    track && picture && comp.tracks.indexOf(track) < comp.tracks.indexOf(picture),
  );
  let trackOps: CompositionOp[];
  if (!track) trackOps = [{ op: 'addTrack', track: videoTrack({ id: trackId }) }];
  else if (lift) {
    trackOps = [
      { op: 'removeTrack', trackId },
      { op: 'addTrack', track: { ...track, clips: kept, transitions: [] } },
    ];
  } else {
    trackOps = track.clips
      .filter((c) => !kept.includes(c))
      .map((c): CompositionOp => ({ op: 'removeClip', clipId: c.id }));
  }
  return {
    ops: added.length > 0 || removed > 0 || lift ? [...trackOps, ...added] : [],
    captions: added.length,
    clipIds: sources.map(({ clip }) => clip.id),
    track: trackId,
  };
}

/** Where the next clip on a clip's track starts (Infinity when it's the last). */
function nextClipStart(comp: Composition, clip: MediaClip): number {
  const track = comp.tracks.find((t) => t.clips.some((c) => c.id === clip.id));
  return (track?.clips ?? [])
    .filter((c) => c.id !== clip.id && c.startSec >= clip.startSec)
    .reduce(
      (next, c) => Math.min(next, Math.max(c.startSec, clipEndSec(clip))),
      Number.POSITIVE_INFINITY,
    );
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

/**
 * Where captions stay clear of what a platform draws over the video. On a
 * portrait canvas (Shorts, Reels, TikTok) that is the bottom quarter and 14%
 * at each side: none of them publishes pixel specs for organic posts and
 * third-party estimates conflict, so one conservative box. Other shapes keep
 * the usual 40 px edge.
 */
export function safeArea(comp: Composition): { side: number; bottom: number } {
  if (comp.height <= comp.width) return { side: TEXT_EDGE_PX, bottom: TEXT_EDGE_PX };
  return {
    side: Math.round(PORTRAIT_SIDE_SHARE * comp.width),
    bottom: Math.round(PORTRAIT_BOTTOM_SHARE * comp.height),
  };
}

/** Captions sized to the canvas: white on a dark box, near the bottom, and on
 *  a portrait canvas inside its safe area. */
export function defaultCaptionStyle(comp: Composition): TextStyle {
  const style: TextStyle = {
    fontSize: Math.round(Math.min(comp.width, comp.height) / 20),
    color: 'white',
    background: 'black@0.6',
    anchor: 'bottom-center' satisfies Anchor,
  };
  if (comp.height <= comp.width) return style;
  // The box drawtext draws behind the text reaches past it, so the text keeps
  // that much further in for the box to stay inside the safe area too.
  const { bottom } = safeArea(comp);
  return { ...style, margin: { x: captionSideMargin(comp), y: bottom + CAPTION_BOX_PX } };
}

/** How far caption text keeps from the side edges: inside the safe area with
 *  its box on a portrait canvas, the usual 40 px otherwise. */
export function captionSideMargin(comp: Composition): number {
  return comp.height <= comp.width ? TEXT_EDGE_PX : safeArea(comp).side + CAPTION_BOX_PX;
}

/** Pixels a caption line's text may take between the style's side margins. */
function captionRoomPx(comp: Composition, style: TextStyle): number {
  return Math.max(1, comp.width - 2 * (style.margin?.x ?? TEXT_EDGE_PX));
}

/**
 * How wide a caption line may be, in em of its font: what fits between the
 * style's side margins at its font size. drawtext doesn't wrap, so a wider
 * line runs off the frame or into a platform's buttons.
 */
export function captionWidthBudget(comp: Composition, style: TextStyle): number {
  return captionRoomPx(comp, style) / style.fontSize;
}

/** The caption style a line is drawn with: a single word too wide for the
 *  room even on a line of its own gets a font size that fits it. */
export function fitCaptionStyle(text: string, style: TextStyle, comp: Composition): TextStyle {
  const width = textWidthEm(text);
  const room = captionRoomPx(comp, style);
  if (width * style.fontSize <= room) return style;
  return { ...style, fontSize: Math.max(1, Math.floor(room / width)) };
}

/**
 * Group a clip's words (timeline times) into captions: a new one starts after
 * `maxWords` words, past 32 characters or `maxWidthEm` em of estimated width,
 * after a pause, or after a sentence ends. Each stays up a moment after its
 * last word, but never into the next one or past `endSec`.
 */
export function groupCaptions(
  words: ClipWord[],
  endSec: number,
  maxWords: number,
  maxWidthEm: number = Number.POSITIVE_INFINITY,
): CaptionCue[] {
  const groups: ClipWord[][] = [];
  let current: ClipWord[] = [];
  for (const word of words) {
    const prev = current[current.length - 1];
    if (
      prev &&
      (current.length >= maxWords ||
        word.startSec - prev.endSec > PAUSE_SEC ||
        endsSentence(prev.text) ||
        tooWide(joinWords([...current, word].map((w) => w.text)), maxWidthEm))
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

// Script_Extensions, not Script: shared marks such as the prolonged sound mark
// ー are Common by script but belong to kana.
const NO_SPACE_SCRIPT =
  /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u;
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

/** Whether a word ends a sentence: it ends in . ! ? … (or 。！？), maybe
 *  followed by a closing quote or bracket. */
export function endsSentence(text: string): boolean {
  return /[.!?。！？…]["')\]」』]?$/u.test(text);
}

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]/u;

/** Width in Latin characters: East Asian characters are drawn about twice as wide. */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += WIDE.test(ch) ? 2 : 1;
  return width;
}

function tooWide(text: string, maxWidthEm: number): boolean {
  return displayWidth(text) > MAX_CAPTION_WIDTH || textWidthEm(text) > maxWidthEm;
}

const WIDEST = /[WMmw@%#&ÆŒæœ]/u;
const NARROW = /[ijlItfr.,:;'’!|()[\]-]/u;
/** ASCII math signs: DejaVu draws them at about 0.84 em. */
const SIGNS = /[+=<>~^]/u;
const ASCII = /^[\x20-\x7e]$/;

/**
 * A line's width in em, estimated from the characters' advances in common
 * sans-serif caption fonts: for each class at least what Arial and DejaVu Sans
 * draw (W and m are about 0.95–1.0 em), so the estimate errs wide and a line it
 * lets through fits on screen. Accented Latin counts as its base letter; other
 * scripts count as their widest letters (DejaVu's Щ and Ю are about 1.1 em).
 */
export function textWidthEm(text: string): number {
  let width = 0;
  for (const ch of text) {
    const base = ch.normalize('NFD').charAt(0);
    if (base === ' ') width += 0.32;
    else if (WIDE.test(ch) || WIDEST.test(base)) width += 1;
    else if (!ASCII.test(base)) width += base === base.toLowerCase() ? 0.95 : 1.1;
    else if (SIGNS.test(base)) width += 0.85;
    else if (NARROW.test(base)) width += 0.4;
    else if (base !== base.toLowerCase()) width += 0.8;
    else width += 0.64;
  }
  return width;
}

function roundMs(sec: number): number {
  return Math.round(sec * 1000) / 1000;
}

function floorMs(sec: number): number {
  return Math.floor(sec * 1000 + 1e-6) / 1000;
}
