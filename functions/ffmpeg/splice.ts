// splice: one MP4 made from trimmed segments of one or more videos, in order. The surgical re-render uses it to join the kept spans of a
// master with a re-rendered window. Each segment is cut from its source and encoded to one shared format (1080 by 1920, 30 frames a second,
// H.264 and AAC), so the join is a stream copy with no drift at the seams. Each segment reads its own source in its own directory.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EngineError } from "../../src/engine/contracts/errors.ts";
import { runTool, type ToolPaths } from "./exec.ts";
import { FFMPEG_LIMITS } from "./limits.ts";
import { materialise, withWorkdir, type SourceOptions } from "./source.ts";
import { parseInput, spliceRequestSchema, type SpliceRequest, type SpliceResult } from "./types.ts";

const STAGE = "media.splice";

export type SpliceRunOptions = SourceOptions & { paths?: ToolPaths };

/** A time in seconds with millisecond precision, as ffmpeg reads it. */
function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

/** Pure: the ffmpeg arguments that cut one segment and encode it to the shared format. The audio is optional: a silent source is cut too. */
export function buildSegmentArgs(input: { inputPath: string; inMs: number; outMs: number; outputPath: string }): string[] {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    seconds(input.inMs),
    "-i",
    input.inputPath,
    "-t",
    seconds(input.outMs - input.inMs),
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-y",
    input.outputPath,
  ];
}

/** Pure: the concat demuxer's arguments. Every part has the shared format, so the parts are copied, not encoded again. */
export function buildJoinArgs(input: { listPath: string; outputPath: string }): string[] {
  return ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", input.listPath, "-c", "copy", "-movflags", "+faststart", "-y", input.outputPath];
}

/** Pure: the list the concat demuxer reads, one part per line, in order. The part names are ours, never a source's name. */
export function joinListOf(parts: readonly string[]): string {
  return `${parts.map((part) => `file '${part}'`).join("\n")}\n`;
}

export async function run(request: SpliceRequest, options: SpliceRunOptions = {}): Promise<SpliceResult> {
  const input = parseInput(spliceRequestSchema, request, STAGE);
  const plannedMs = input.segments.reduce((total, segment) => total + (segment.outMs - segment.inMs), 0);
  return withWorkdir(async (dir) => {
    const parts: string[] = [];
    for (const [index, segment] of input.segments.entries()) {
      const segmentDir = join(dir, `segment-${index}`);
      await mkdir(segmentDir);
      const media = await materialise(segment.source, segmentDir, options);
      const part = join(dir, `part-${index}.mp4`);
      await runTool(
        "ffmpeg",
        buildSegmentArgs({ inputPath: media.path, inMs: segment.inMs, outMs: segment.outMs, outputPath: part }),
        { timeoutMs: FFMPEG_LIMITS.toolTimeoutMs.splice, stage: STAGE, paths: options.paths },
      );
      parts.push(`part-${index}.mp4`);
    }
    const listPath = join(dir, "parts.txt");
    await writeFile(listPath, joinListOf(parts));
    const outputPath = join(dir, "spliced.mp4");
    await runTool("ffmpeg", buildJoinArgs({ listPath, outputPath }), {
      timeoutMs: FFMPEG_LIMITS.toolTimeoutMs.splice,
      stage: STAGE,
      paths: options.paths,
    });
    const bytes = await readFile(outputPath);
    if (bytes.byteLength > FFMPEG_LIMITS.maxInputBytes) {
      throw new EngineError("provider", "the spliced media is larger than the functions accept", { stage: STAGE });
    }
    return { mediaType: "video/mp4", base64: bytes.toString("base64"), durationMs: plannedMs };
  });
}
