// Client for loudness (Bible 6.2, 6.11, 12.3). Two forms: in-process (tests and CI) and over HTTP (production).

import { run as runLoudness } from "../../../functions/ffmpeg/loudness.ts";
import { sourceToWire, wireLoudnessRequestSchema } from "../../../functions/ffmpeg/wire.ts";
import {
  loudnessRequestSchema,
  loudnessResultSchema,
  parseInput,
  type LoudnessRequest,
  type LoudnessResult,
} from "../../../functions/ffmpeg/types.ts";
import { mediaConfig } from "./config.ts";
import type { WirePost } from "./wire-client.ts";

export const LOUDNESS_PATH = "/loudness";

export type LoudnessClient = (request: LoudnessRequest) => Promise<LoudnessResult>;

export function loudnessInProcess(): LoudnessClient {
  return async (request) =>
    runLoudness(parseInput(loudnessRequestSchema, request, "media.loudness"));
}

export function loudnessOverWire(post: WirePost): LoudnessClient {
  return async (request) => {
    const input = parseInput(loudnessRequestSchema, request, "media.loudness");
    const body = { source: sourceToWire(input.source) };
    parseInput(wireLoudnessRequestSchema, body, "media.loudness");
    return post(LOUDNESS_PATH, body, loudnessResultSchema, mediaConfig.callTimeoutMs.loudness);
  };
}
