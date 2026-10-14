// loudness: EBU R128 integrated loudness, true peak and loudness range from the ebur128 filter (Bible 6.2, 6.11, 12.3).
// The filter prints its summary to stderr at the end of the run.

import { EngineError } from "../../src/engine/contracts/errors.ts";
import { runTool, type ToolPaths } from "./exec.ts";
import { FFMPEG_LIMITS } from "./limits.ts";
import { materialise, withWorkdir, type SourceOptions } from "./source.ts";
import {
  loudnessRequestSchema,
  parseInput,
  type LoudnessRequest,
  type LoudnessResult,
} from "./types.ts";

const STAGE = "media.loudness";

/** BS.1770 absolute gate: a measurement at or below this means nothing was above the gate (for example silence). */
const ABSOLUTE_GATE_LUFS = -70;

export type LoudnessRunOptions = SourceOptions & { paths?: ToolPaths };

export type BuildLoudnessArgsInput = { inputPath: string };

/** Pure: the ffmpeg arguments that measure the first audio stream and print the summary. */
export function buildArgs(input: BuildLoudnessArgsInput): string[] {
  return [
    "-nostdin",
    "-hide_banner",
    "-nostats",
    "-loglevel",
    "info",
    "-i",
    input.inputPath,
    "-filter_complex",
    "[0:a:0]ebur128=peak=true:framelog=quiet[measured]",
    "-map",
    "[measured]",
    "-f",
    "null",
    "-",
  ];
}

function measured(value: string): number | null {
  if (value === "-inf") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Pure: reads the ebur128 summary from ffmpeg's stderr. A missing summary is a provider error, not a zero. A value at
 * or below the absolute gate is returned as null.
 */
export function parse(stderr: string): LoudnessResult {
  const integrated = /Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/.exec(stderr);
  const range = /Loudness range:\s*\n\s*LRA:\s*(-?[\d.]+|-inf)\s*LU/.exec(stderr);
  const peak = /True peak:\s*\n\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS/.exec(stderr);
  if (!integrated || !range || !peak) {
    throw new EngineError("provider", "the ebur128 summary is missing from ffmpeg's output", {
      stage: STAGE,
    });
  }
  const lufs = measured(integrated[1] ?? "-inf");
  return {
    integratedLufs: lufs === null || lufs <= ABSOLUTE_GATE_LUFS ? null : lufs,
    truePeakDbtp: measured(peak[1] ?? "-inf"),
    loudnessRangeLu: measured(range[1] ?? "-inf"),
  };
}

export async function run(
  request: LoudnessRequest,
  options: LoudnessRunOptions = {},
): Promise<LoudnessResult> {
  const input = parseInput(loudnessRequestSchema, request, STAGE);
  return withWorkdir(async (dir) => {
    const media = await materialise(input.source, dir, options);
    const output = await runTool("ffmpeg", buildArgs({ inputPath: media.path }), {
      timeoutMs: FFMPEG_LIMITS.toolTimeoutMs.loudness,
      stage: STAGE,
      paths: options.paths,
    });
    return parse(output.stderr);
  });
}
