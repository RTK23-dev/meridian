// Client for frames, and the frame plan of Bible 6.2: a frame at every cut, plus 2 per second, capped at 60 per video.
// Cuts come first. If the cuts alone exceed the cap, they are thinned evenly and the plan says so (cutsCovered false),
// so the caller can fail the reference gate instead of claiming full coverage.

import { readPngSize } from "../../../functions/ffmpeg/png.ts";
import { run as runFrames } from "../../../functions/ffmpeg/frames.ts";
import { FFMPEG_LIMITS } from "../../../functions/ffmpeg/limits.ts";
import {
  sourceToWire,
  wireFramesResultSchema,
  type WireFramesResult,
} from "../../../functions/ffmpeg/wire.ts";
import {
  framesRequestSchema,
  parseInput,
  type Frame,
  type FramesRequest,
  type FramesResult,
} from "../../../functions/ffmpeg/types.ts";
import { thresholds } from "../config/thresholds.ts";
import { mediaConfig } from "./config.ts";
import type { WirePost } from "./wire-client.ts";
import { EngineError } from "../contracts/errors.ts";

export const FRAMES_PATH = "/frames";

export type FramesClient = (request: FramesRequest) => Promise<FramesResult>;

export type FramePlan = {
  /** Requested times in milliseconds, ascending and unique. */
  atMs: number[];
  /** False when the cuts alone exceeded the cap and some cuts have no frame. */
  cutsCovered: boolean;
  droppedCuts: number;
  /** Two-per-second samples that were not kept because the cap was reached. */
  droppedSamples: number;
};

export type PlanInput = {
  durationMs: number;
  cutsMs: readonly number[];
  framesPerSecond: number;
  maxFrames: number;
  /** One frame in milliseconds (the EDL frame rate). */
  frameMs: number;
};

/** Evenly spaced picks from an ascending list, keeping its first and last items when possible. */
function evenly<Item>(items: readonly Item[], count: number): Item[] {
  if (count >= items.length) {
    return [...items];
  }
  if (count <= 0) {
    return [];
  }
  if (count === 1) {
    return [items[0]!];
  }
  const picks: Item[] = [];
  for (let i = 0; i < count; i++) {
    picks.push(items[Math.round((i * (items.length - 1)) / (count - 1))]!);
  }
  return picks;
}

/** Drops times that fall within one frame of the previous kept time. */
function spaced(sorted: readonly number[], gapMs: number): number[] {
  const kept: number[] = [];
  for (const ms of sorted) {
    if (kept.length === 0 || ms - kept[kept.length - 1]! >= gapMs) {
      kept.push(ms);
    }
  }
  return kept;
}

/** Pure: the times to sample for one video, under the cap. */
export function planFrameTimes(input: PlanInput): FramePlan {
  const lastStartMs = input.durationMs - input.frameMs;
  const inRange = (ms: number): boolean => ms >= 0 && ms <= lastStartMs;

  const cuts = spaced(
    [...new Set(input.cutsMs.map((ms) => Math.round(ms)))].filter(inRange).sort((a, b) => a - b),
    input.frameMs,
  );

  const interval = 1000 / input.framesPerSecond;
  const sampleCount = Math.floor((input.durationMs * input.framesPerSecond) / 1000);
  const samples = Array.from({ length: sampleCount }, (_, k) => Math.round((k + 0.5) * interval))
    .filter(inRange)
    .filter((ms) => cuts.every((cut) => Math.abs(cut - ms) >= input.frameMs));

  const keptCuts = evenly(cuts, input.maxFrames);
  const droppedCuts = cuts.length - keptCuts.length;
  const keptSamples = evenly(samples, input.maxFrames - keptCuts.length);
  const droppedSamples = samples.length - keptSamples.length;

  return {
    atMs: [...keptCuts, ...keptSamples].sort((a, b) => a - b),
    cutsCovered: droppedCuts === 0,
    droppedCuts,
    droppedSamples,
  };
}

/** The plan with the Bible 6.2 settings: 2 per second, capped at 60, one frame of 1 / 30 s. */
export function planForVideo(durationMs: number, cutsMs: readonly number[]): FramePlan {
  return planFrameTimes({
    durationMs,
    cutsMs,
    framesPerSecond: thresholds.reference.framesPerSecond,
    maxFrames: thresholds.reference.maxFrames,
    frameMs: mediaConfig.frameMs,
  });
}

export function framesInProcess(): FramesClient {
  return async (request) => runFrames(parseInput(framesRequestSchema, request, "media.frames"));
}

/**
 * Checks each returned frame: the times must match the request in order, each PNG must be well formed, and its size
 * must match the declared width and height. A frame that fails any check is a provider error, never a shorter result.
 */
export function decodeFramesResponse(request: FramesRequest, wire: WireFramesResult): FramesResult {
  if (wire.frames.length !== request.atMs.length) {
    throw new EngineError(
      "provider",
      `media function returned ${wire.frames.length} frames for ${request.atMs.length} requests`,
      {
        stage: "media.frames",
      },
    );
  }
  const frames: Frame[] = wire.frames.map((frame, index) => {
    if (frame.atMs !== request.atMs[index]) {
      throw new EngineError(
        "provider",
        `media function returned frame ${frame.atMs} ms where ${request.atMs[index]} ms was asked`,
        {
          stage: "media.frames",
        },
      );
    }
    const png = new Uint8Array(Buffer.from(frame.pngBase64, "base64"));
    const size = readPngSize(png);
    if (!size || size.width !== frame.width || size.height !== frame.height) {
      throw new EngineError(
        "provider",
        `the frame at ${frame.atMs} ms is not a PNG of the declared size`,
        {
          stage: "media.frames",
        },
      );
    }
    if (png.byteLength > FFMPEG_LIMITS.maxFramePngBytes) {
      throw new EngineError(
        "provider",
        `the frame at ${frame.atMs} ms is above the frame size limit`,
        { stage: "media.frames" },
      );
    }
    return { atMs: frame.atMs, width: frame.width, height: frame.height, png };
  });
  return { frames };
}

export function framesOverWire(post: WirePost): FramesClient {
  return async (request) => {
    const input = parseInput(framesRequestSchema, request, "media.frames");
    const body = {
      source: sourceToWire(input.source),
      atMs: input.atMs,
      ...(input.longSidePx === undefined ? {} : { longSidePx: input.longSidePx }),
    };
    const wire = await post(
      FRAMES_PATH,
      body,
      wireFramesResultSchema,
      mediaConfig.callTimeoutMs.frames,
    );
    return decodeFramesResponse(input, wire);
  };
}

/**
 * Samples a video at its planned times and returns the frames with the plan. The plan's cutsCovered flag is returned
 * with the frames: a caller that needs every cut must check it.
 */
export async function framesAtCutsAndSamples(
  functions: { frames(request: FramesRequest): Promise<FramesResult> },
  input: {
    source: FramesRequest["source"];
    durationMs: number;
    cutsMs: readonly number[];
    longSidePx?: number;
  },
): Promise<{ plan: FramePlan; frames: Frame[] }> {
  const plan = planForVideo(input.durationMs, input.cutsMs);
  if (plan.atMs.length === 0) {
    throw new EngineError("invalid_input", "no frame time falls inside the media", {
      stage: "media.frames",
    });
  }
  const result = await functions.frames({
    source: input.source,
    atMs: plan.atMs,
    ...(input.longSidePx === undefined ? {} : { longSidePx: input.longSidePx }),
  });
  return { plan, frames: result.frames };
}
