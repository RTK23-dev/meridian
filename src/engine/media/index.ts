// Public surface of the media workstream for production code. It does not export the in-process implementation
// (local.ts) or the recorded speech-to-text adapter (recordedSpeechToText in stt.ts); those are for tests and CI.

export type {
  CutsCallRequest,
  CutsResult,
  DetectorRequest,
  Frame,
  FramesRequest,
  FramesResult,
  LoudnessRequest,
  LoudnessResult,
  MediaDetectors,
  MediaFunctions,
  MediaSource,
  ProbeRequest,
  ProbeResult,
  TimelineRequest,
  TimelineResult,
  TimelineSample,
  LoudnessSample,
  BlackFramesResult,
  DetectRun,
  FlickerResult,
  MotionResult,
  SilenceResult,
} from "./interface.ts";
export { DETECTOR_PATHS, detectorsOverWire } from "./detectors.ts";
export {
  blackAt,
  blackFrameMeasures,
  longestRunFrames,
  takeCodeMeasures,
  type TakeCodeMeasures,
} from "./measures.ts";
export { timelineInProcess, timelineOverWire, type TimelineClient } from "./timeline.ts";
export { pictureInProcess, pictureOverWire, PICTURE_PATH, type PictureClient } from "./picture.ts";
export type {
  PicturePair,
  PictureRequest,
  PictureResult,
} from "../../../functions/ffmpeg/types.ts";
export { httpMediaFunctions, type HttpMediaFunctions } from "./http.ts";
export {
  type MediaTransport,
  type MediaTransportRequest,
  type MediaTransportResponse,
  type WirePost,
} from "./wire-client.ts";
export { framesAtCutsAndSamples, planForVideo, planFrameTimes, type FramePlan } from "./frames.ts";
export {
  checkRenderIntegrity,
  integrityLimitsFromConfig,
  type IntegrityLimits,
  type RenderIntegrityInput,
} from "./integrity.ts";
export {
  attemptKey,
  estimateSttUsd,
  isRefusalBeforeWork,
  normaliseTranscript,
  transcribeMetered,
  sttIdempotencyKey,
  SttCallError,
  type MeteredSttResult,
  type SpeechToText,
  type SttMeter,
  type SttRequest,
  type SttResult,
} from "./stt.ts";
export { mediaConfig } from "./config.ts";
export {
  NOT_CONNECTED,
  notConnectedReason,
  pricePerMinuteOf,
  speechPortsOf,
  speechToTextConnection,
  type SpeechPorts,
  type SpeechToTextConnection,
} from "./stt-connection.ts";
export {
  DEEPGRAM_PROVIDER,
  deepgramBillReader,
  deepgramForRoute,
  deepgramProjects,
  deepgramSpeechToText,
  type DeepgramOptions,
  type DeepgramProjects,
  type ProjectLookup,
} from "./stt-deepgram.ts";
export {
  MEDIA_FUNCTIONS_MODE_SETTING,
  MEDIA_FUNCTIONS_MODES,
  parseMediaFunctionsMode,
  type MediaFunctionsMode,
} from "./mode.ts";
