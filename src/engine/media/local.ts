// The in-process media functions (Bible 15.2, owner decision 2026-10-16). The handlers of functions/ffmpeg run in this process,
// through the ffmpeg binary on PATH, and answer what the deployed functions answer. Two callers use them. Tests and CI run real
// media through them. The worker uses them when the composition root chooses the in-process mode (MEDIA_FUNCTIONS_MODE=in_process,
// see mode.ts), and then the worker's image needs ffmpeg (the root Dockerfile installs it). Otherwise production takes the HTTP form,
// httpMediaFunctions, through the gateway.
//
// The limits are the serverless limits, unchanged: functions/ffmpeg/limits.ts bounds the input and output sizes, the stdout, each tool
// timeout and the frame caps, and every run removes its temporary directory on success and on failure.
//
// URL inputs are refused here. The handlers would fetch a URL with the global fetch, in this process, and the engine never calls fetch
// outside gateway/transport.ts. Production passes bytes (from the object store), so no production path needs a URL in this process.
//
// Only the composition root (jobs/runtime.ts) may import this module. boundaries.test.ts fails for any other production file.

import { EngineError } from "../contracts/errors.ts";
import { cutsInProcess } from "./cuts.ts";
import { detectorsInProcess } from "./detectors.ts";
import { framesInProcess } from "./frames.ts";
import type { HttpMediaFunctions } from "./http.ts";
import { loudnessInProcess } from "./loudness.ts";
import { pictureInProcess } from "./picture.ts";
import { probeInProcess } from "./probe.ts";
import { timelineInProcess } from "./timeline.ts";

/** The source is a URL: the handler would fetch it with the global fetch. */
function isUrlSource(request: unknown): boolean {
  if (typeof request !== "object" || request === null || !("source" in request)) {
    return false;
  }
  const source: unknown = request.source;
  return typeof source === "object" && source !== null && "kind" in source && source.kind === "url";
}

/** Refuses a URL source before the handler runs. Any other request, valid or not, goes to the handler, which validates it. */
function bytesOnly<Request, Result>(
  stage: string,
  run: (request: Request) => Promise<Result>,
): (request: Request) => Promise<Result> {
  return async (request: Request): Promise<Result> => {
    if (isUrlSource(request)) {
      throw new EngineError(
        "invalid_input",
        "the in-process media functions take bytes: a URL is fetched by the serverless functions, never by this process",
        { stage },
      );
    }
    return run(request);
  };
}

/**
 * The in-process media functions, typed as the HTTP form is (HttpMediaFunctions), so the composition root can pass either one where
 * production takes MediaFunctions. The id names the implementation in logs and manifests.
 */
export function inProcessMediaFunctions(): HttpMediaFunctions {
  const detectors = detectorsInProcess();
  return {
    id: "in_process:ffmpeg",
    probe: bytesOnly("media.probe", probeInProcess()),
    frames: bytesOnly("media.frames", framesInProcess()),
    loudness: bytesOnly("media.loudness", loudnessInProcess()),
    cuts: bytesOnly("media.cuts", cutsInProcess()),
    timeline: bytesOnly("media.timeline", timelineInProcess()),
    picture: bytesOnly("media.picture", pictureInProcess()),
    blackFrames: bytesOnly("media.black_frames", detectors.blackFrames),
    flicker: bytesOnly("media.flicker", detectors.flicker),
    motion: bytesOnly("media.motion", detectors.motion),
    silence: bytesOnly("media.silence", detectors.silence),
  };
}
