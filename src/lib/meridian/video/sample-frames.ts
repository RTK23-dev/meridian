/**
 * Samples still frames from a stored video at real timestamps, with ffmpeg.
 *
 * The sampled timestamp is the time ffmpeg seeks to for that frame, and it is the timestamp recorded with the frame. It
 * is never estimated from a scene list, and a frame that cannot be extracted is recorded as a failure, not replaced. When
 * ffmpeg is not installed or the video's duration is unknown, nothing is sampled and the reason is returned.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const FRAME_SAMPLER_VERSION = "ffmpeg-sample.v1";
export const DEFAULT_SAMPLE_COUNT = 8;
export const MAX_SAMPLE_CONTAINER_BYTES = 200 * 1024 * 1024;
const FRAME_TIMEOUT_MS = 30_000;
const END_MARGIN_MS = 250;
const FRAME_MAX_BYTES = 32 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type SampledFrame = { timestampMs: number; bytes: Uint8Array };
export type SampleFailure = { timestampMs: number; reason: "extract_failed" | "not_png" };
export type SampleResult = {
  version: typeof FRAME_SAMPLER_VERSION;
  frames: SampledFrame[];
  failures: SampleFailure[];
  /** Set when sampling could not run at all. Frames and failures are empty in that case. */
  unavailable?: "no_duration" | "ffmpeg_unavailable" | "container_too_large";
};

/** Extracts one frame at a timestamp. Throws when the frame cannot be produced. */
export type FrameExtractor = (containerPath: string, timestampMs: number) => Promise<Uint8Array>;

/**
 * Evenly spaced timestamps from the opening frame toward the end of the media. The last one stays a margin before the end,
 * because a seek into the final frames often finds no decodable frame.
 */
export function sampleTimestamps(durationMs: number, count = DEFAULT_SAMPLE_COUNT): number[] {
  if (count <= 1) return [0];
  const last = Math.max(0, Math.floor(durationMs - END_MARGIN_MS));
  const times = Array.from({ length: count }, (_, index) => Math.round((last * index) / (count - 1)));
  return [...new Set(times)];
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.byteLength >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

export function ffmpegExtractor(ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg"): FrameExtractor {
  return async (containerPath, timestampMs) => {
    // Output seeking (-ss after -i) is accurate to the frame, so the frame is the one at the recorded time.
    const seconds = (timestampMs / 1000).toFixed(3);
    const { stdout } = await execFileAsync(
      ffmpegPath,
      ["-nostdin", "-v", "error", "-i", containerPath, "-ss", seconds, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"],
      { encoding: "buffer", timeout: FRAME_TIMEOUT_MS, maxBuffer: FRAME_MAX_BYTES },
    );
    return new Uint8Array(stdout as unknown as Buffer);
  };
}

function isFfmpegMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export async function sampleVideoFrames(input: {
  bytes: Uint8Array;
  durationMs: number | null;
  count?: number;
  extractor?: FrameExtractor;
}): Promise<SampleResult> {
  const base = { version: FRAME_SAMPLER_VERSION } as const;
  if (input.durationMs === null || input.durationMs <= 0) return { ...base, frames: [], failures: [], unavailable: "no_duration" };
  if (input.bytes.byteLength > MAX_SAMPLE_CONTAINER_BYTES) {
    return { ...base, frames: [], failures: [], unavailable: "container_too_large" };
  }
  const dir = await mkdtemp(join(tmpdir(), "meridian-frames-"));
  const containerPath = join(dir, "container");
  try {
    await writeFile(containerPath, input.bytes);
    const extract = input.extractor ?? ffmpegExtractor();
    const frames: SampledFrame[] = [];
    const failures: SampleFailure[] = [];
    for (const timestampMs of sampleTimestamps(input.durationMs, input.count)) {
      try {
        const bytes = await extract(containerPath, timestampMs);
        if (!isPng(bytes)) {
          failures.push({ timestampMs, reason: "not_png" });
          continue;
        }
        frames.push({ timestampMs, bytes });
      } catch (error) {
        if (isFfmpegMissing(error)) return { ...base, frames: [], failures: [], unavailable: "ffmpeg_unavailable" };
        failures.push({ timestampMs, reason: "extract_failed" });
      }
    }
    return { ...base, frames, failures };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
