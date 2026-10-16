// Client for the detectors (Bible 6.7 step 1, 12.2, 12.3): black and frozen frames, flicker, motion and silence. Two forms:
// in-process (tests and CI) and over HTTP (production). Every answer is untrusted: it must match the result schema of its own
// function, and a mismatch is a provider error. Nothing here sets a default for a failed or missing measure.

import {
  blackFramesRun,
  flickerRun,
  motionRun,
  silenceRun,
} from "../../../functions/ffmpeg/detectors.ts";
import { sourceToWire, wireProbeRequestSchema } from "../../../functions/ffmpeg/wire.ts";
import {
  blackFramesResultSchema,
  detectRequestSchema,
  flickerResultSchema,
  motionResultSchema,
  parseInput,
  silenceResultSchema,
} from "../../../functions/ffmpeg/types.ts";
import type { ZodType } from "zod";
import { EngineError } from "../contracts/errors.ts";
import { mediaConfig } from "./config.ts";
import type { DetectorRequest, MediaDetectors } from "./interface.ts";
import type { WirePost } from "./wire-client.ts";

const STAGE = "media.detectors";

/** The HTTP path of each detector on the media functions' deployment. */
export const DETECTOR_PATHS = {
  blackFrames: "/black",
  flicker: "/flicker",
  motion: "/motion",
  silence: "/silence",
} as const;

/** Checks an in-process answer against its schema, so both forms refuse the same malformed result. */
function decode<Body>(schema: ZodType<Body>, value: unknown, name: string): Body {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new EngineError(
      "provider",
      `the ${name} measure does not match its contract: ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`,
      { stage: STAGE },
    );
  }
  return parsed.data;
}

/** In-process form: runs the handlers here, through the ffmpeg on this machine (tests and CI). */
export function detectorsInProcess(): MediaDetectors {
  return {
    blackFrames: async (request) =>
      decode(
        blackFramesResultSchema,
        await blackFramesRun(parseInput(detectRequestSchema, request, STAGE)),
        "black-frame",
      ),
    flicker: async (request) =>
      decode(
        flickerResultSchema,
        await flickerRun(parseInput(detectRequestSchema, request, STAGE)),
        "flicker",
      ),
    motion: async (request) =>
      decode(
        motionResultSchema,
        await motionRun(parseInput(detectRequestSchema, request, STAGE)),
        "motion",
      ),
    silence: async (request) =>
      decode(
        silenceResultSchema,
        await silenceRun(parseInput(detectRequestSchema, request, STAGE)),
        "silence",
      ),
  };
}

/** HTTP form: POST /black, /flicker, /motion and /silence on the media functions' deployment. */
export function detectorsOverWire(post: WirePost): MediaDetectors {
  const call =
    <Body>(path: string, schema: ZodType<Body>, timeoutMs: number) =>
    async (request: DetectorRequest): Promise<Body> => {
      const input = parseInput(detectRequestSchema, request, STAGE);
      const body = { source: sourceToWire(input.source) };
      parseInput(wireProbeRequestSchema, body, STAGE);
      return post(path, body, schema, timeoutMs);
    };
  return {
    blackFrames: call(
      DETECTOR_PATHS.blackFrames,
      blackFramesResultSchema,
      mediaConfig.callTimeoutMs.black,
    ),
    flicker: call(DETECTOR_PATHS.flicker, flickerResultSchema, mediaConfig.callTimeoutMs.flicker),
    motion: call(DETECTOR_PATHS.motion, motionResultSchema, mediaConfig.callTimeoutMs.motion),
    silence: call(DETECTOR_PATHS.silence, silenceResultSchema, mediaConfig.callTimeoutMs.silence),
  };
}
