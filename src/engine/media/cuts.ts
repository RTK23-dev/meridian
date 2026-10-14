// Client for cuts (Bible 6.2). The scene score defaults to mediaConfig.sceneCutScore when the caller leaves it out.

import { run as runCuts } from "../../../functions/ffmpeg/cuts.ts";
import {
  cutsResultSchema,
  cutsRequestSchema,
  parseInput,
  type CutsResult,
} from "../../../functions/ffmpeg/types.ts";
import { sourceToWire } from "../../../functions/ffmpeg/wire.ts";
import type { CutsCallRequest } from "./interface.ts";
import { mediaConfig } from "./config.ts";
import type { WirePost } from "./wire-client.ts";

export const CUTS_PATH = "/cuts";

export type CutsClient = (request: CutsCallRequest) => Promise<CutsResult>;

/** Fills in the default scene score and validates the request. */
export function resolveCutsRequest(request: CutsCallRequest) {
  return parseInput(
    cutsRequestSchema,
    { source: request.source, sceneScore: request.sceneScore ?? mediaConfig.sceneCutScore.value },
    "media.cuts",
  );
}

export function cutsInProcess(): CutsClient {
  return async (request) => runCuts(resolveCutsRequest(request));
}

export function cutsOverWire(post: WirePost): CutsClient {
  return async (request) => {
    const input = resolveCutsRequest(request);
    return post(
      CUTS_PATH,
      { source: sourceToWire(input.source), sceneScore: input.sceneScore },
      cutsResultSchema,
      mediaConfig.callTimeoutMs.cuts,
    );
  };
}
