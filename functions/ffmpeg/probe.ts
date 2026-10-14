// probe: container, codecs, size, frame rate, duration and audio presence (Bible 6.2 and 6.11). ffprobe with JSON output.

import { EngineError } from "../../src/engine/contracts/errors.ts";
import { runTool, type ToolPaths } from "./exec.ts";
import { FFMPEG_LIMITS } from "./limits.ts";
import { materialise, withWorkdir, type SourceOptions } from "./source.ts";
import {
  parseInput,
  probeRequestSchema,
  probeResultSchema,
  type ProbeRequest,
  type ProbeResult,
} from "./types.ts";

const STAGE = "media.probe";

export type ProbeRunOptions = SourceOptions & { paths?: ToolPaths };

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** ffprobe prints durations in seconds as strings. The result is integer milliseconds. */
function durationMs(value: unknown): number | null {
  const seconds =
    typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

function rational(value: unknown): { num: number; den: number; value: number } | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) {
    return null;
  }
  const num = Number(match[1]);
  const den = Number(match[2]);
  if (num <= 0 || den <= 0) {
    return null;
  }
  return { num, den, value: num / den };
}

export type BuildProbeArgsInput = { inputPath: string };

/** Pure: the ffprobe arguments for a local file. */
export function buildArgs(input: BuildProbeArgsInput): string[] {
  return [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    "-i",
    input.inputPath,
  ];
}

/**
 * Pure: turns ffprobe's JSON into a ProbeResult. bytes is the size of the file that was probed. A file without any
 * stream is invalid_input; a missing field is null.
 */
export function parse(stdout: string, fileBytes: number): ProbeResult {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new EngineError("provider", "ffprobe did not return JSON", { stage: STAGE });
  }
  if (!isRecord(json)) {
    throw new EngineError("provider", "ffprobe returned JSON that is not an object", {
      stage: STAGE,
    });
  }
  const format = isRecord(json.format) ? json.format : {};
  const streams = Array.isArray(json.streams) ? json.streams.filter(isRecord) : [];
  if (streams.length === 0) {
    throw new EngineError("invalid_input", "the media has no streams", { stage: STAGE });
  }
  const video =
    streams.find(
      (stream) =>
        stream.codec_type === "video" &&
        !(isRecord(stream.disposition) && stream.disposition.attached_pic === 1),
    ) ?? null;
  const audio = streams.find((stream) => stream.codec_type === "audio") ?? null;
  const fps = rational(video?.avg_frame_rate) ?? rational(video?.r_frame_rate) ?? null;

  return probeResultSchema.parse({
    container: text(format.format_name),
    videoCodec: video ? text(video.codec_name) : null,
    audioCodec: audio ? text(audio.codec_name) : null,
    width: video ? positiveInt(video.width) : null,
    height: video ? positiveInt(video.height) : null,
    fps,
    durationMs: durationMs(format.duration) ?? (video ? durationMs(video.duration) : null),
    audioPresent: audio !== null,
    bytes: fileBytes,
  });
}

/** Probes a file that is already on disk. Shared with frames, which needs the size for its scale. */
export async function probeFile(
  inputPath: string,
  fileBytes: number,
  options: ProbeRunOptions = {},
): Promise<ProbeResult> {
  const output = await runTool("ffprobe", buildArgs({ inputPath }), {
    timeoutMs: FFMPEG_LIMITS.toolTimeoutMs.probe,
    stage: STAGE,
    paths: options.paths,
  });
  return parse(output.stdout.toString("utf8"), fileBytes);
}

/** Runs the probe on a source: validates the request, fetches or writes the media, probes it, and cleans up. */
export async function run(
  request: ProbeRequest,
  options: ProbeRunOptions = {},
): Promise<ProbeResult> {
  const input = parseInput(probeRequestSchema, request, STAGE);
  return withWorkdir(async (dir) => {
    const media = await materialise(input.source, dir, options);
    return probeFile(media.path, media.bytes, options);
  });
}
