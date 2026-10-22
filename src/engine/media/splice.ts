// The splice media function: one MP4 joined from trimmed segments, for the surgical re-render (Bible 6.x, the window of a remake). It is a
// sibling of MediaFunctions, as the detectors are: a required member on MediaFunctions would break every object typed as MediaFunctions.
// In process it runs functions/ffmpeg/splice through the ffmpeg on PATH, and URL sources are refused. Over HTTP it posts to /splice.
// Every result is untrusted: a 200 must match the result schema, and each failure is a typed EngineError.

import { EngineError } from "../contracts/errors.ts";
import { run as runSplice } from "../../../functions/ffmpeg/splice.ts";
import { sourceToWire } from "../../../functions/ffmpeg/wire.ts";
import { spliceRequestSchema, spliceResultSchema, type SpliceRequest, type SpliceResult } from "../../../functions/ffmpeg/types.ts";
import { mediaConfig } from "./config.ts";
import type { WirePost } from "./wire-client.ts";

export const SPLICE_PATH = "/splice";

export interface MediaEditors {
  /** Joins the segments in order. durationMs is the requested total, not a length measured from the output. */
  splice(request: SpliceRequest): Promise<SpliceResult>;
}

/** The request, checked by the schema before anything runs. A refusal names the first problem, never the media itself. */
function checked(request: unknown): SpliceRequest {
  const parsed = spliceRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new EngineError("invalid_input", `the splice request is not valid: ${parsed.error.issues[0]?.message ?? "unknown"}`, {
      stage: "media.splice",
    });
  }
  return parsed.data;
}

/** In process: the splice runs in this process. URL sources are refused, because only bytes are read here. */
export function spliceInProcess(): MediaEditors {
  return {
    splice: async (request) => runSplice(checked(request), { urlPolicy: () => false }),
  };
}

/** Over HTTP: each segment's source travels as a wire source, and the 200 answer is checked against the result schema. */
export function spliceOverWire(post: WirePost): MediaEditors {
  return {
    splice: async (request) => {
      const input = checked(request);
      return post(
        SPLICE_PATH,
        {
          segments: input.segments.map((segment) => ({
            source: sourceToWire(segment.source),
            inMs: segment.inMs,
            outMs: segment.outMs,
          })),
        },
        spliceResultSchema,
        mediaConfig.callTimeoutMs.splice,
      );
    },
  };
}
