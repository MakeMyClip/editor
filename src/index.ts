export { buildTrimArgs, type TrimArgs } from './ffmpeg/args/trim.js';
export {
  type AudioStream,
  type MediaProbe,
  parseProbeOutput,
  probe,
  type VideoStream,
} from './ffmpeg/probe.js';
export { runFfmpeg } from './ffmpeg/run.js';
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
export { IngestInput, type IngestInputType, type IngestResult, ingest } from './tools/ingest.js';
export { TrimInput, type TrimInputType, type TrimResult, trim } from './tools/trim.js';
