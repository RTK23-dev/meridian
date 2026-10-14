// Client for probe (Bible 6.2, 6.11). Two forms: in-process (tests and CI) and over HTTP (production).

import { run as runProbe } from "../../../functions/ffmpeg/probe.ts";
import { sourceToWire } from "../../../functions/ffmpeg/wire.ts";
import {
  parseInput,
  probeRequestSchema,
  probeResultSchema,
  type ProbeRequest,
  type ProbeResult,
} from "../../../functions/ffmpeg/types.ts";
import { mediaConfig } from "./config.ts";
import type { WirePost } from "./wire-client.ts";

export const PROBE_PATH = "/probe";

export type ProbeClient = (request: ProbeRequest) => Promise<ProbeResult>;

export function probeInProcess(): ProbeClient {
  return async (request) => runProbe(parseInput(probeRequestSchema, request, "media.probe"));
}

export function probeOverWire(post: WirePost): ProbeClient {
  return async (request) => {
    const input = parseInput(probeRequestSchema, request, "media.probe");
    return post(
      PROBE_PATH,
      { source: sourceToWire(input.source) },
      probeResultSchema,
      mediaConfig.callTimeoutMs.probe,
    );
  };
}
