// picture: the zoom and loop measures of one reference (Bible 6.2 step 6, 8.1 motion and endsOnLoop). ffmpeg writes a grayscale
// thumbnail of every picture sample (PICTURE_STEPS.sampleMs) to a raw file in the temporary directory, and the last frame of
// the picture to a second file. Then, for each pair of neighbouring thumbnails, the scale (and shift) that best maps the earlier
// one onto the later one, and the share of their difference that this model leaves (fit). A pair that straddles a scene cut is
// not measured. The loop distance is the mean luma difference of the first frame and the true last frame.
//
// The functions only measure. src/engine/analyze/zoom.ts decides which pairs are zoom jumps and whether the picture loops. A
// frame that cannot be read is a provider error, never a shorter result. Nothing here is a default.
//
// The scale model: the later thumbnail is the earlier one magnified by `scale` about the frame's centre and moved by a shift
// (a fraction of the width and of the height). The fit is judged inside a central region, so a moving edge at the border of the
// frame does not count against it. The search is coarse (a grid), then fine around the best coarse scale when it differs from 1.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EngineError } from "../../src/engine/contracts/errors.ts";
import { runTool, type ToolPaths } from "./exec.ts";
import { FFMPEG_LIMITS } from "./limits.ts";
import { probeFile } from "./probe.ts";
import { materialise, withWorkdir, type SourceOptions } from "./source.ts";
import {
  PICTURE_STEPS,
  parseInput,
  pictureRequestSchema,
  type PicturePair,
  type PictureRequest,
  type PictureResult,
} from "./types.ts";

const STAGE = "media.picture";

/** The search of the scale model. Initial values: they set the method's resolution, and are not tuned thresholds. */
export const PICTURE_SEARCH = {
  /**
   * The coarse grid: scales from scaleMin to scaleMax in coarseScaleStep steps, jointly with shifts of the content (x and y, as a
   * fraction of the width and of the height) from -coarseShiftRange to +coarseShiftRange in coarseShiftStep steps. A zoom that is
   * not centred on the frame moves the content, so the shift must be searched with the scale, not after it.
   */
  scaleMin: 0.8,
  scaleMax: 1.3,
  coarseScaleStep: 0.02,
  coarseShiftRange: 0.08,
  coarseShiftStep: 0.08,
  /** The fine search: shifts within fineShiftRange of the coarse best, then the scale within fineScaleRange, in fineScaleStep steps. */
  fineShiftRange: 0.04,
  fineShiftStep: 0.02,
  fineScaleRange: 0.02,
  fineScaleStep: 0.005,
  /** A mean difference (0 to 1) at or below this is the same picture: scale 1 and fit 1. */
  noiseFloor: 0.01,
  /** The compared region lies within maskFraction of the width (x) and of the height (y) from the centre. */
  maskFraction: 0.25,
} as const;

export type PictureRunOptions = SourceOptions & { paths?: ToolPaths };

export type ScaleFit = { scale: number; fit: number };

type Model = { scale: number; shiftX: number; shiftY: number };
const IDENTITY: Model = { scale: 1, shiftX: 0, shiftY: 0 };

/** The values from `from` to `to` in `step` steps, rounded to three decimals so that the grid points are exact. */
function steps(from: number, to: number, step: number): number[] {
  const count = Math.round((to - from) / step);
  return Array.from({ length: count + 1 }, (_, index) =>
    Math.round((from + index * step) * 1000) / 1000,
  );
}

/**
 * The mean absolute luma difference (0 to 1) between the later thumbnail and the earlier one mapped by the model, over the
 * central region, with nearest-pixel sampling. A region with no overlap is the worst value (1), never a best one.
 */
function residual(a: Uint8Array, b: Uint8Array, width: number, height: number, model: Model): number {
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const reachX = PICTURE_SEARCH.maskFraction * width;
  const reachY = PICTURE_SEARCH.maskFraction * height;
  const shiftX = model.shiftX * width;
  const shiftY = model.shiftY * height;
  // The source column and row of each column and row of the later thumbnail, computed once per candidate (not per pixel).
  // A value outside the thumbnail is -1 and its pixels are skipped.
  const sourceXs = new Int32Array(width);
  for (let x = 0; x < width; x++) {
    const source = Math.round(cx + (x - cx - shiftX) / model.scale);
    sourceXs[x] = source < 0 || source >= width ? -1 : source;
  }
  const sourceYs = new Int32Array(height);
  for (let y = 0; y < height; y++) {
    const source = Math.round(cy + (y - cy - shiftY) / model.scale);
    sourceYs[y] = source < 0 || source >= height ? -1 : source;
  }
  // The compared region is a rectangle around the centre: its rows and columns are contiguous, so the loops run over them directly.
  const firstX = Math.max(0, Math.ceil(cx - reachX));
  const lastX = Math.min(width - 1, Math.floor(cx + reachX));
  const firstY = Math.max(0, Math.ceil(cy - reachY));
  const lastY = Math.min(height - 1, Math.floor(cy + reachY));
  let sum = 0;
  let count = 0;
  for (let y = firstY; y <= lastY; y++) {
    const sourceY = sourceYs[y] ?? -1;
    if (sourceY < 0) continue;
    const rowB = y * width;
    const rowA = sourceY * width;
    for (let x = firstX; x <= lastX; x++) {
      const sourceX = sourceXs[x] ?? -1;
      if (sourceX < 0) continue;
      sum += Math.abs((b[rowB + x] ?? 0) - (a[rowA + sourceX] ?? 0));
      count++;
    }
  }
  return count === 0 ? 1 : sum / (count * 255);
}

/**
 * Pure: the scale that maps thumbnail a onto thumbnail b, and the share of their difference that it leaves (fit, 0 to 1). Two
 * thumbnails of the same picture (a difference at the noise floor) are scale 1 and fit 1. The search never returns a model worse
 * than the identity, so fit is at most 1.
 */
export function fitScale(a: Uint8Array, b: Uint8Array, width: number, height: number): ScaleFit {
  const identity = residual(a, b, width, height, IDENTITY);
  if (identity <= PICTURE_SEARCH.noiseFloor) return { scale: 1, fit: 1 };

  // Coarse: every scale of the grid with every coarse shift. The best one is kept, identity included.
  let best: Model = IDENTITY;
  let bestResidual = identity;
  const scales = steps(PICTURE_SEARCH.scaleMin, PICTURE_SEARCH.scaleMax, PICTURE_SEARCH.coarseScaleStep);
  const coarseShifts = steps(
    -PICTURE_SEARCH.coarseShiftRange,
    PICTURE_SEARCH.coarseShiftRange,
    PICTURE_SEARCH.coarseShiftStep,
  );
  for (const scale of scales) {
    for (const shiftX of coarseShifts) {
      for (const shiftY of coarseShifts) {
        const candidate: Model = { scale, shiftX, shiftY };
        const value = residual(a, b, width, height, candidate);
        if (value < bestResidual) {
          best = candidate;
          bestResidual = value;
        }
      }
    }
  }

  // Fine: the shift around the coarse best at its scale, then the scale around that shift. Skipped when the best is the identity.
  const moved = best.scale !== 1 || best.shiftX !== 0 || best.shiftY !== 0;
  if (moved) {
    const coarseScale = best.scale;
    const fineShifts = steps(
      -PICTURE_SEARCH.fineShiftRange,
      PICTURE_SEARCH.fineShiftRange,
      PICTURE_SEARCH.fineShiftStep,
    );
    const centreX = best.shiftX;
    const centreY = best.shiftY;
    for (const dx of fineShifts) {
      for (const dy of fineShifts) {
        const candidate: Model = { scale: coarseScale, shiftX: centreX + dx, shiftY: centreY + dy };
        const value = residual(a, b, width, height, candidate);
        if (value < bestResidual) {
          best = candidate;
          bestResidual = value;
        }
      }
    }
    const shiftX = best.shiftX;
    const shiftY = best.shiftY;
    const fineScales = steps(
      coarseScale - PICTURE_SEARCH.fineScaleRange,
      coarseScale + PICTURE_SEARCH.fineScaleRange,
      PICTURE_SEARCH.fineScaleStep,
    );
    for (const scale of fineScales) {
      const candidate: Model = { scale, shiftX, shiftY };
      const value = residual(a, b, width, height, candidate);
      if (value < bestResidual) {
        best = candidate;
        bestResidual = value;
      }
    }
  }

  return { scale: best.scale, fit: Math.min(1, bestResidual / identity) };
}

/** Pure: the mean absolute luma difference of two thumbnails of the same size, 0 (the same) to 1 (opposite). */
export function lumaDistance(a: Uint8Array, b: Uint8Array): number {
  if (a.byteLength !== b.byteLength || a.byteLength === 0) {
    throw new EngineError("provider", "the first and last frames of the picture have different sizes", {
      stage: STAGE,
    });
  }
  let sum = 0;
  for (let index = 0; index < a.byteLength; index++) {
    sum += Math.abs((a[index] ?? 0) - (b[index] ?? 0));
  }
  return sum / (a.byteLength * 255);
}

/**
 * Pure: the thumbnail size for a picture of the given size. The width is fixed; the height follows the aspect ratio and is even.
 * A picture with no size is refused by the caller before this runs.
 */
export function thumbnailSize(width: number, height: number): { width: number; height: number } {
  const thumbWidth = PICTURE_STEPS.thumbWidthPx;
  const thumbHeight = Math.max(2, 2 * Math.round((thumbWidth * height) / width / 2));
  return { width: thumbWidth, height: thumbHeight };
}

/** Pure: arguments that write every thumbnail (one every sampleMs) as raw 8-bit grayscale to outPath. */
export function gridArgs(input: { inputPath: string; outPath: string; width: number; height: number }): string[] {
  const rate = 1000 / PICTURE_STEPS.sampleMs;
  return [
    "-nostdin",
    "-hide_banner",
    "-nostats",
    "-loglevel",
    "error",
    "-i",
    input.inputPath,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    `fps=${rate},scale=${input.width}:${input.height},format=gray`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    input.outPath,
  ];
}

/**
 * Pure: arguments that write every thumbnail of the last tailWindowMs of the picture as raw grayscale to outPath. The last
 * thumbnail in that file is the picture's true last frame: the seek is taken from the end of the stream, not from a sample time.
 */
export function tailArgs(input: { inputPath: string; outPath: string; width: number; height: number }): string[] {
  return [
    "-nostdin",
    "-hide_banner",
    "-nostats",
    "-loglevel",
    "error",
    "-sseof",
    `-${PICTURE_STEPS.tailWindowMs / 1000}`,
    "-i",
    input.inputPath,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    `scale=${input.width}:${input.height},format=gray`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    input.outPath,
  ];
}

/** Runs the picture measures on a source: probes it, writes the thumbnails, measures every pair, and cleans up. */
export async function run(request: PictureRequest, options: PictureRunOptions = {}): Promise<PictureResult> {
  const input = parseInput(pictureRequestSchema, request, STAGE);
  const cuts = [...new Set(input.cutsMs)].sort((a, b) => a - b);
  return withWorkdir(async (dir) => {
    const media = await materialise(input.source, dir, options);
    const probe = await probeFile(media.path, media.bytes, options);
    if (probe.videoCodec === null || probe.width === null || probe.height === null) {
      throw new EngineError("invalid_input", "the media has no picture to measure", { stage: STAGE });
    }
    if (probe.durationMs === null) {
      throw new EngineError(
        "invalid_input",
        "the media's duration is unknown, so its thumbnails cannot be placed in time",
        { stage: STAGE },
      );
    }
    if (probe.durationMs > FFMPEG_LIMITS.maxPictureMs) {
      throw new EngineError(
        "invalid_input",
        `the media is ${probe.durationMs} ms, above the ${FFMPEG_LIMITS.maxPictureMs} ms picture limit`,
        { stage: STAGE },
      );
    }

    const { width, height } = thumbnailSize(probe.width, probe.height);
    const frameBytes = width * height;
    const gridPath = join(dir, "grid.gray");
    await runTool("ffmpeg", gridArgs({ inputPath: media.path, outPath: gridPath, width, height }), {
      timeoutMs: FFMPEG_LIMITS.toolTimeoutMs.picture,
      stage: STAGE,
      paths: options.paths,
    });
    const grid = new Uint8Array(await readFile(gridPath));
    const count = Math.floor(grid.byteLength / frameBytes);
    const frame = (index: number): Uint8Array => grid.subarray(index * frameBytes, (index + 1) * frameBytes);

    let loopDistance: number | null = null;
    if (count >= 2) {
      const tailPath = join(dir, "tail.gray");
      await runTool("ffmpeg", tailArgs({ inputPath: media.path, outPath: tailPath, width, height }), {
        timeoutMs: FFMPEG_LIMITS.toolTimeoutMs.picture,
        stage: STAGE,
        paths: options.paths,
      });
      const tail = new Uint8Array(await readFile(tailPath));
      if (tail.byteLength < frameBytes || tail.byteLength % frameBytes !== 0) {
        throw new EngineError("provider", "the last frame of the picture could not be read", { stage: STAGE });
      }
      loopDistance = lumaDistance(frame(0), tail.subarray(tail.byteLength - frameBytes));
    }

    const pairs: PicturePair[] = [];
    for (let index = 0; index + 1 < count; index++) {
      const fromMs = index * PICTURE_STEPS.sampleMs;
      const atMs = fromMs + PICTURE_STEPS.sampleMs;
      // A cut at time c starts a new shot at c: the pair crosses it when the earlier thumbnail is before c and the later at or after.
      if (cuts.some((cut) => cut > fromMs && cut <= atMs)) {
        pairs.push({ atMs, usable: false, scale: null, fit: null });
        continue;
      }
      const fit = fitScale(frame(index), frame(index + 1), width, height);
      pairs.push({ atMs, usable: true, scale: fit.scale, fit: fit.fit });
    }

    return { sampleMs: PICTURE_STEPS.sampleMs, width, height, pairs, loopDistance };
  });
}
