// The one interface production code uses for the media functions (Bible 2 and 15.2). Production takes MediaFunctions;
// it never imports the in-process implementation (see local.ts and boundaries.test.ts).

import type {
  BlackFramesResult,
  CutsResult,
  FlickerResult,
  FramesRequest,
  FramesResult,
  LoudnessRequest,
  LoudnessResult,
  MediaSource,
  MotionResult,
  ProbeRequest,
  ProbeResult,
  SilenceResult,
  TimelineRequest,
  TimelineResult,
} from "../../../functions/ffmpeg/types.ts";

export type {
  BlackFramesResult,
  CutsResult,
  DetectRun,
  FlickerResult,
  Frame,
  FramesRequest,
  FramesResult,
  LoudnessRequest,
  LoudnessResult,
  MediaSource,
  MotionResult,
  ProbeRequest,
  ProbeResult,
  SilenceResult,
  TimelineRequest,
  TimelineResult,
  TimelineSample,
  LoudnessSample,
} from "../../../functions/ffmpeg/types.ts";

/** What a caller passes to cuts. sceneScore defaults to mediaConfig.sceneCutScore. */
export type CutsCallRequest = { source: MediaSource; sceneScore?: number };

/**
 * The four media functions. Every method either resolves with a validated result or rejects with an EngineError:
 * kind invalid_input for a bad request or media, provider (retryable or not) for a failed or untrustworthy call, config
 * when a binary or URL is not set up. Nothing resolves with a default for a failure.
 */
export interface MediaFunctions {
  /** Names the implementation in logs and manifests, for example "http:media-functions". */
  readonly id: string;
  probe(request: ProbeRequest): Promise<ProbeResult>;
  frames(request: FramesRequest): Promise<FramesResult>;
  loudness(request: LoudnessRequest): Promise<LoudnessResult>;
  cuts(request: CutsCallRequest): Promise<CutsResult>;
  /** Per-sample brightness, motion, momentary loudness and the audio envelope of one video (Bible 6.2 step 2). */
  timeline(request: TimelineRequest): Promise<TimelineResult>;
}

/** What a caller passes to a detector: the media only. */
export type DetectorRequest = { source: MediaSource };

/**
 * The detectors (Bible 6.7 step 1, 12.2, 12.3): black and frozen frames, flicker, motion and silence. They are a sibling of
 * MediaFunctions, not part of it: adding required members to MediaFunctions would break every object typed as MediaFunctions
 * (the voice and jobs test fixtures). Each consumer takes the detectors it needs with Pick<MediaDetectors, ...>. The same
 * rules as MediaFunctions apply: a validated result or a typed EngineError, never a default.
 */
export interface MediaDetectors {
  blackFrames(request: DetectorRequest): Promise<BlackFramesResult>;
  flicker(request: DetectorRequest): Promise<FlickerResult>;
  motion(request: DetectorRequest): Promise<MotionResult>;
  silence(request: DetectorRequest): Promise<SilenceResult>;
}
