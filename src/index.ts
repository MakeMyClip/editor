export {
  type AddAudioArgs,
  type AddAudioMode,
  buildAddAudioArgs,
} from './ffmpeg/args/add-audio.js';
export { type AddTextArgs, buildAddTextArgs, type NamedPosition } from './ffmpeg/args/add-text.js';
export { type AdjustArgs, buildAdjustArgs } from './ffmpeg/args/adjust.js';
export { buildChromaKeyArgs, type ChromaKeyArgs } from './ffmpeg/args/chroma-key.js';
export { buildConcatArgs, type ConcatArgs } from './ffmpeg/args/concat.js';
export {
  buildOverlayArgs,
  type OverlayArgs,
  type OverlayPosition,
} from './ffmpeg/args/overlay.js';
export { buildPreviewFrameArgs, type PreviewFrameArgs } from './ffmpeg/args/preview.js';
export {
  buildRenderArgs,
  type RenderArgs,
  type RenderFormat,
  type RenderPreset,
} from './ffmpeg/args/render.js';
export { buildAtempoChain, buildSpeedArgs, type SpeedArgs } from './ffmpeg/args/speed.js';
export { buildSplitArgs } from './ffmpeg/args/split.js';
export {
  buildVidstabDetectArgs,
  buildVidstabTransformArgs,
  type VidstabDetectArgs,
  type VidstabTransformArgs,
} from './ffmpeg/args/stabilize.js';
export {
  buildCropArgs,
  buildFlipArgs,
  buildRotateArgs,
  buildScaleArgs,
  type CropArgs,
  type FlipArgs,
  type RotateArgs,
  type ScaleArgs,
  type TransformOp,
} from './ffmpeg/args/transform.js';
export {
  buildTransitionArgs,
  type TransitionArgs,
  type TransitionKind,
} from './ffmpeg/args/transition.js';
export { buildTrimArgs, type TrimArgs } from './ffmpeg/args/trim.js';
export { buildZoomPanArgs, type ZoomPanArgs } from './ffmpeg/args/zoom-pan.js';
export { quoteFilterArg } from './ffmpeg/escape.js';
export {
  type AudioStream,
  type MediaProbe,
  parseProbeOutput,
  probe,
  type VideoStream,
} from './ffmpeg/probe.js';
export { runFfmpeg } from './ffmpeg/run.js';
export {
  appendOp,
  makeEntryId,
  mutateSession,
  overwriteSession,
  readSession,
  SessionConflictError,
  SessionCorruptError,
  sessionPath,
  snapshotPath,
  snapshotsDir,
  writeSession,
  writeSessionIfUnchanged,
} from './session/store.js';
export {
  EMPTY_SESSION,
  type Session,
  type SessionEntry,
  SessionEntrySchema,
  SessionSchema,
} from './session/types.js';
export {
  AudioStreamSchema,
  type Clip,
  ClipSchema,
  type MediaId,
  MediaIdSchema,
  type MediaRef,
  MediaRefSchema,
  makeMediaId,
  type Timecode,
  TimecodeSchema,
  type Timeline,
  TimelineSchema,
  VideoStreamSchema,
} from './timeline/schema.js';
export {
  AddAudioInput,
  type AddAudioInputType,
  type AddAudioResult,
  addAudio,
} from './tools/add-audio.js';
// Phase 3 — safety + composites
export {
  AddCaptionsInput,
  type AddCaptionsInputType,
  type AddCaptionsResult,
  addCaptions,
} from './tools/add-captions.js';
export {
  AddTextInput,
  type AddTextInputType,
  type AddTextResult,
  addText,
} from './tools/add-text.js';
export {
  AddTitleCardInput,
  type AddTitleCardInputType,
  type AddTitleCardResult,
  addTitleCard,
} from './tools/add-title-card.js';
export { AdjustInput, type AdjustInputType, type AdjustResult, adjust } from './tools/adjust.js';
// Phase 4 — specialty
export {
  ChromaKeyInput,
  type ChromaKeyInputType,
  type ChromaKeyResult,
  chromaKey,
} from './tools/chroma-key.js';
export {
  buildConcatListContent,
  ConcatInput,
  type ConcatInputType,
  type ConcatResult,
  concat,
} from './tools/concat.js';
export {
  DeleteOpInput,
  type DeleteOpInputType,
  type DeleteOpResult,
  deleteOp,
} from './tools/delete-op.js';
export {
  HighlightReelInput,
  type HighlightReelInputType,
  type HighlightReelResult,
  highlightReel,
} from './tools/highlight-reel.js';
export { IngestInput, type IngestInputType, type IngestResult, ingest } from './tools/ingest.js';
export {
  InspectInput,
  type InspectInputType,
  type InspectResult,
  inspect,
} from './tools/inspect.js';
export {
  OverlayInput,
  type OverlayInputType,
  type OverlayResult,
  overlay,
} from './tools/overlay.js';
export {
  PreviewInput,
  type PreviewInputType,
  type PreviewResult,
  preview,
} from './tools/preview.js';
export { RenderInput, type RenderInputType, type RenderResult, render } from './tools/render.js';
export {
  computeKeepRegions,
  parseSilences,
  SilenceRemoveInput,
  type SilenceRemoveInputType,
  type SilenceRemoveResult,
  silenceRemove,
} from './tools/silence-remove.js';
export {
  SnapshotInput,
  type SnapshotInputType,
  type SnapshotResult,
  snapshot,
} from './tools/snapshot.js';
export { SpeedInput, type SpeedInputType, type SpeedResult, speed } from './tools/speed.js';
export { SplitInput, type SplitInputType, type SplitResult, split } from './tools/split.js';
export {
  StabilizeInput,
  type StabilizeInputType,
  type StabilizeResult,
  stabilize,
} from './tools/stabilize.js';
export {
  TransformInput,
  type TransformInputType,
  type TransformResult,
  transform,
} from './tools/transform.js';
export {
  TransitionInput,
  type TransitionInputType,
  type TransitionResult,
  transition,
} from './tools/transition.js';
export { TrimInput, type TrimInputType, type TrimResult, trim } from './tools/trim.js';
export { UndoInput, type UndoInputType, type UndoResult, undo } from './tools/undo.js';
export {
  ZoomPanInput,
  type ZoomPanInputType,
  type ZoomPanResult,
  zoomPan,
} from './tools/zoom-pan.js';
