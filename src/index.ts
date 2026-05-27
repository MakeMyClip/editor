export { buildTrimArgs, type TrimArgs } from './ffmpeg/args/trim.js';
export { runFfmpeg } from './ffmpeg/run.js';
export {
  type Clip,
  ClipSchema,
  type Timecode,
  TimecodeSchema,
  type Timeline,
  TimelineSchema,
} from './timeline/schema.js';
export { TrimInput, type TrimInputType, type TrimResult, trim } from './tools/trim.js';
