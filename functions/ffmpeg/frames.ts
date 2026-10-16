// frames: one PNG per requested time (Bible 6.2 and 6.7). One ffmpeg process decodes the file once and writes one output
// per timestamp, each with output seeking (-ss after -i), so every frame is the first decoded frame at or after its time.
// A time at or past the last frame writes no file. That is an invalid_input error, never a silent skip.

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EngineError } from "../../src/engine/contracts/errors.ts";
import { runTool, stderrTail } from "./exec.ts";
import { FFMPEG_LIMITS } from "./limits.ts";
import { probeFile, type ProbeRunOptions } from "./probe.ts";
import { materialise, withWorkdir } from "./source.ts";
import {
  framesRequestSchema,
  parseInput,
  type Frame,
  type FramesRequest,
  type FramesResult,
} from "./types.ts";
import { readPngSize } from "./png.ts";

const STAGE = "media.frames";

export type Scale = { width: number; height: number };

export type BuildFramesArgsInput = {
  inputPath: string;
  atMs: readonly number[];
  outDir: string;
  scale: Scale | null;
};

/** File name of the output for the request at this index. */
export function frameFileName(index: number): string {
  return `frame-${String(index).padStart(3, "0")}.png`;
}

/** Seconds for ffmpeg, to the millisecond. */
function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

/** Pure: one output per requested time, in request order. */
export function buildArgs(input: BuildFramesArgsInput): string[] {
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", input.inputPath];
  input.atMs.forEach((ms, index) => {
    args.push("-map", "0:v:0", "-ss", seconds(ms), "-frames:v", "1");
    if (input.scale) {
      args.push("-vf", `scale=${input.scale.width}:${input.scale.height}`);
    }
    args.push("-c:v", "png", "-f", "image2", join(input.outDir, frameFileName(index)));
  });
  return args;
}

/**
 * Pure: the output size for a long side limit. Null when the frame is already no longer than the limit (no upscaling).
 * Both sides are even, as the scale filter and most encoders expect.
 */
export function scaleFor(width: number, height: number, longSidePx: number): Scale | null {
  const longest = Math.max(width, height);
  if (longest <= longSidePx) {
    return null;
  }
  const factor = longSidePx / longest;
  const even = (value: number): number => Math.max(2, 2 * Math.round(value / 2));
  return { width: even(width * factor), height: even(height * factor) };
}

/**
 * Pure: pairs each requested time with its PNG. A null entry means ffmpeg wrote no frame for that time. Each PNG is
 * checked for its structure and size before it is returned.
 */
export function parse(
  atMs: readonly number[],
  pngs: readonly (Uint8Array<ArrayBuffer> | null)[],
  stderr = "",
): Frame[] {
  return atMs.map((ms, index) => {
    const png = pngs[index];
    if (!png) {
      const detail = stderr.trim() ? ` (${stderrTail(stderr)})` : "";
      throw new EngineError(
        "invalid_input",
        `no decodable frame at ${ms} ms: the time is at or past the last frame of the media${detail}`,
        { stage: STAGE },
      );
    }
    const size = readPngSize(png);
    if (!size) {
      throw new EngineError(
        "provider",
        `ffmpeg wrote a file for ${ms} ms that is not a valid PNG`,
        { stage: STAGE },
      );
    }
    if (png.byteLength > FFMPEG_LIMITS.maxFramePngBytes) {
      throw new EngineError(
        "provider",
        `the frame at ${ms} ms is ${png.byteLength} bytes, above the frame limit`,
        {
          stage: STAGE,
        },
      );
    }
    return { atMs: ms, width: size.width, height: size.height, png };
  });
}

async function readOrNull(path: string): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** Extracts the frames. The source is fetched or written, probed when a scale is asked, and removed afterwards. */
export async function run(
  request: FramesRequest,
  options: ProbeRunOptions = {},
): Promise<FramesResult> {
  const input = parseInput(framesRequestSchema, request, STAGE);
  return withWorkdir(async (dir) => {
    const media = await materialise(input.source, dir, options);
    let scale: Scale | null = null;
    if (input.longSidePx !== undefined) {
      const info = await probeFile(media.path, media.bytes, options);
      if (info.width === null || info.height === null) {
        throw new EngineError(
          "invalid_input",
          "the media has no video stream to take frames from",
          { stage: STAGE },
        );
      }
      scale = scaleFor(info.width, info.height, input.longSidePx);
    }
    const outDir = join(dir, "frames");
    await mkdir(outDir);
    const output = await runTool(
      "ffmpeg",
      buildArgs({ inputPath: media.path, atMs: input.atMs, outDir, scale }),
      {
        timeoutMs: FFMPEG_LIMITS.toolTimeoutMs.frames,
        stage: STAGE,
        paths: options.paths,
      },
    );
    const pngs = await Promise.all(
      input.atMs.map((_, index) => readOrNull(join(outDir, frameFileName(index)))),
    );
    const frames = parse(input.atMs, pngs, output.stderr);
    const total = frames.reduce((sum, frame) => sum + frame.png.byteLength, 0);
    if (total > FFMPEG_LIMITS.maxFramesOutputBytes) {
      throw new EngineError(
        "invalid_input",
        `the frames total ${total} bytes, above the ${FFMPEG_LIMITS.maxFramesOutputBytes} byte response limit; ask for a longSidePx`,
        { stage: STAGE },
      );
    }
    return { frames };
  });
}
