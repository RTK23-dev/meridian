// Client for the timeline (Bible 6.2 step 2): brightness, motion, momentary loudness and the audio envelope of one video in
// one call. Two forms: in-process (tests and CI) and over HTTP (production). Every answer is untrusted: it must match the
// result schema, and its sample times must run forward (a series that goes back in time is a provider error).

import { run as runTimeline } from "../../../functions/ffmpeg/timeline.ts";
import { sourceToWire, wireTimelineRequestSchema } from "../../../functions/ffmpeg/wire.ts";
import {
  parseInput,
  timelineRequestSchema,
  timelineResultSchema,
  type TimelineRequest,
  type TimelineResult,
} from "../../../functions/ffmpeg/types.ts";
import { EngineError } from "../contracts/errors.ts";
import { mediaConfig } from "./config.ts";
import type { WirePost } from "./wire-client.ts";

export const TIMELINE_PATH = "/timeline";

export type TimelineClient = (request: TimelineRequest) => Promise<TimelineResult>;

const STAGE = "media.timeline";

function refuseUnordered(result: TimelineResult): TimelineResult {
  const series: Array<[string, Array<{ atMs: number }>]> = [
    ["brightness", result.brightness],
    ["motion", result.motion],
    ["loudness", result.loudness],
  ];
  for (const [name, samples] of series) {
    for (let i = 1; i < samples.length; i++) {
      if ((samples[i]?.atMs ?? 0) <= (samples[i - 1]?.atMs ?? 0)) {
        throw new EngineError(
          "provider",
          `the ${name} series of the timeline does not run forward in time`,
          { stage: STAGE },
        );
      }
    }
  }
  if (result.videoPresent && result.brightness.length === 0) {
    throw new EngineError(
      "provider",
      "the timeline reports a video stream but measured no brightness",
      { stage: STAGE },
    );
  }
  if (result.audioPresent && result.envelope.rms.length === 0) {
    throw new EngineError(
      "provider",
      "the timeline reports an audio stream but measured no envelope",
      { stage: STAGE },
    );
  }
  return result;
}

/** In-process form: runs the handler here, through the ffmpeg on this machine (tests and CI). */
export function timelineInProcess(): TimelineClient {
  return async (request) =>
    refuseUnordered(await runTimeline(parseInput(timelineRequestSchema, request, STAGE)));
}

/** HTTP form: POST /timeline on the media functions' deployment. */
export function timelineOverWire(post: WirePost): TimelineClient {
  return async (request) => {
    const input = parseInput(timelineRequestSchema, request, STAGE);
    const body = { source: sourceToWire(input.source) };
    parseInput(wireTimelineRequestSchema, body, STAGE);
    const result = await post(
      TIMELINE_PATH,
      body,
      timelineResultSchema,
      mediaConfig.callTimeoutMs.timeline,
    );
    return refuseUnordered(result);
  };
}
