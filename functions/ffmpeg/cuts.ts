// cuts: scene-change timestamps (Bible 6.2). The select filter keeps frames whose scene score is above the threshold, and
// showinfo prints each kept frame's presentation time to stderr.

import { EngineError } from "../../src/engine/contracts/errors.ts";
import { runTool, type ToolPaths } from "./exec.ts";
import { FFMPEG_LIMITS } from "./limits.ts";
import { materialise, withWorkdir, type SourceOptions } from "./source.ts";
import { cutsRequestSchema, parseInput, type CutsRequest, type CutsResult } from "./types.ts";

const STAGE = "media.cuts";

export type CutsRunOptions = SourceOptions & { paths?: ToolPaths };

export type BuildCutsArgsInput = { inputPath: string; sceneScore: number };

/** Pure: the ffmpeg arguments. The threshold is written with four decimals, which the filter parses exactly. */
export function buildArgs(input: BuildCutsArgsInput): string[] {
  const score = input.sceneScore.toFixed(4);
  return [
    "-nostdin",
    "-hide_banner",
    "-nostats",
    "-loglevel",
    "info",
    "-i",
    input.inputPath,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    `select='gt(scene\\,${score})',showinfo`,
    "-f",
    "null",
    "-",
  ];
}

/**
 * Pure: reads the kept frames' times from showinfo's stderr lines. A kept frame without a numeric time is a provider
 * error. Times are integer milliseconds, ascending and unique.
 */
export function parse(stderr: string): number[] {
  const cuts: number[] = [];
  for (const line of stderr.split("\n")) {
    // Frame lines carry the frame index (n:); showinfo's configuration lines (time base, colour) do not.
    if (!/Parsed_showinfo.*\sn:\s*\d+/.test(line)) {
      continue;
    }
    const match = /pts_time:(-?\d+(?:\.\d+)?)/.exec(line);
    if (!match) {
      throw new EngineError("provider", "a scene-cut frame has no numeric presentation time", {
        stage: STAGE,
      });
    }
    const ms = Math.round(Number(match[1]) * 1000);
    if (!Number.isFinite(ms) || ms < 0) {
      throw new EngineError("provider", "a scene-cut frame has a negative presentation time", {
        stage: STAGE,
      });
    }
    cuts.push(ms);
  }
  const sorted = [...new Set(cuts)].sort((a, b) => a - b);
  return sorted;
}

export async function run(request: CutsRequest, options: CutsRunOptions = {}): Promise<CutsResult> {
  const input = parseInput(cutsRequestSchema, request, STAGE);
  return withWorkdir(async (dir) => {
    const media = await materialise(input.source, dir, options);
    const output = await runTool(
      "ffmpeg",
      buildArgs({ inputPath: media.path, sceneScore: input.sceneScore }),
      {
        timeoutMs: FFMPEG_LIMITS.toolTimeoutMs.cuts,
        stage: STAGE,
        paths: options.paths,
      },
    );
    return { cutsMs: parse(output.stderr) };
  });
}
