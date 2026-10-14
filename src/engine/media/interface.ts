// The one interface production code uses for the media functions (Bible 2 and 15.2). Production takes MediaFunctions;
// it never imports the in-process implementation (see local.ts and boundaries.test.ts).

import type {
  CutsResult,
  FramesRequest,
  FramesResult,
  LoudnessRequest,
  LoudnessResult,
  MediaSource,
  ProbeRequest,
  ProbeResult,
  TimelineRequest,
  TimelineResult,
} from "../../../functions/ffmpeg/types.ts";

export type {
  CutsResult,
  Frame,
  FramesRequest,
  FramesResult,
  LoudnessRequest,
  LoudnessResult,
  MediaSource,
  ProbeRequest,
  ProbeResult,
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
