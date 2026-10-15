// The detectors (Bible 6.7 step 1, 12.2, 12.3): black and frozen frames, flicker, motion and silence. Four stateless functions
// over one media source. Black and frozen runs share one ffmpeg pass; flicker and motion each read the luma of every frame on
// a 160 px copy; silence is one pass over the first audio stream. The argument builders and the parsers are pure and exported
// for tests. The parsers read the lines this ffmpeg build prints (6.1.1). A span still open at the end of the media is closed
// at the probed duration; with no duration it is a provider error, never a guess. Nothing here decides a limit: the consumers
// read their limits from configuration.

import { EngineError } from "../../src/engine/contracts/errors.ts";
import { runTool, type ToolPaths } from "./exec.ts";
import { FFMPEG_LIMITS } from "./limits.ts";
import { probeFile } from "./probe.ts";
import { materialise, withWorkdir, type SourceOptions } from "./source.ts";
import { parseSignalSeries } from "./timeline.ts";
import {
  DETECT_STEPS,
  MAX_DETECT_RUNS,
  detectRequestSchema,
  parseInput,
  type BlackFramesResult,
  type DetectRequest,
  type DetectRun,
  type FlickerResult,
  type MotionResult,
  type SilenceResult,
} from "./types.ts";

const STAGE = "media.detectors";
const SIGNAL_KEY = "lavfi.signalstats.YAVG";
/** The width of the copy the luma is measured on. The timeline measures on the same width. */
const MEASURE_WIDTH_PX = 160;
const COMMON = ["-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", "-i"] as const;

export type DetectorRunOptions = SourceOptions & { paths?: ToolPaths };

/** Pure: blackdetect and freezedetect in one pass. Their reports are on stderr. */
export function blackFramesArgs(inputPath: string): string[] {
  const filter = [
    `scale=${MEASURE_WIDTH_PX}:-2`,
    `blackdetect=d=0.001:pix_th=${DETECT_STEPS.blackPixelThreshold}:pic_th=${DETECT_STEPS.blackPictureThreshold}`,
    `freezedetect=n=${DETECT_STEPS.freezeNoise}:d=0.001`,
  ].join(",");
  return [...COMMON, inputPath, "-map", "0:v:0", "-an", "-vf", filter, "-f", "null", "-"];
}

/** Pure: the mean luma of every frame (0 to 255) on stderr, one value per frame. */
export function lumaArgs(inputPath: string): string[] {
  const filter = `scale=${MEASURE_WIDTH_PX}:-2,signalstats,metadata=mode=print:key=${SIGNAL_KEY}`;
  return [...COMMON, inputPath, "-map", "0:v:0", "-an", "-vf", filter, "-f", "null", "-"];
}

/** Pure: the mean absolute luma change between consecutive frames (0 to 255) on stderr, one value per frame pair. */
export function motionEnergyArgs(inputPath: string): string[] {
  const filter = `scale=${MEASURE_WIDTH_PX}:-2,tblend=all_mode=difference,signalstats,metadata=mode=print:key=${SIGNAL_KEY}`;
  return [...COMMON, inputPath, "-map", "0:v:0", "-an", "-vf", filter, "-f", "null", "-"];
}

/** Pure: silencedetect on the first audio stream. Its report is on stderr. */
export function silenceArgs(inputPath: string): string[] {
  const filter = `silencedetect=noise=${DETECT_STEPS.silenceNoiseDb}dB:d=${DETECT_STEPS.minSilenceMs / 1000}`;
  return [...COMMON, inputPath, "-map", "0:a:0", "-vn", "-af", filter, "-f", "null", "-"];
}

type SpanKind = "black" | "freeze" | "silence";

/** The start and end lines of each report, as ffmpeg prints them. The duration lines are not needed (the span is end minus start). */
const SPAN_EVENTS: Record<SpanKind, RegExp> = {
  black: /black_(start|end):\s*(\S+)/g,
  freeze: /freeze_(start|end):\s*(\S+)/g,
  silence: /silence_(start|end):\s*(\S+)/g,
};

function providerError(message: string): EngineError {
  return new EngineError("provider", message, { stage: STAGE });
}

function toMs(text: string, kind: SpanKind): number {
  const seconds = Number(text);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw providerError(`a ${kind} time is not a non-negative number`);
  }
  return Math.round(seconds * 1000);
}

function spanOf(startMs: number, endMs: number): DetectRun {
  return { startMs, endMs, durationMs: endMs - startMs };
}

/**
 * Pure: the spans of one report, in order. A start is closed by the next end. A span still open at the end of the report is
 * closed at durationMs, and with no duration it is a provider error. An end with no start, a start inside an open span, or
 * spans that overlap refuse the whole report: nothing is repaired or guessed.
 */
export function parseSpans(stderr: string, kind: SpanKind, durationMs: number | null): DetectRun[] {
  const runs: DetectRun[] = [];
  let openMs: number | null = null;
  for (const line of stderr.split("\n")) {
    for (const match of line.matchAll(SPAN_EVENTS[kind])) {
      const ms = toMs(match[2] ?? "", kind);
      if (match[1] === "start") {
        if (openMs !== null)
          throw providerError(`the ${kind} report starts a span inside an open span`);
        openMs = ms;
        continue;
      }
      if (openMs === null) throw providerError(`the ${kind} report ends a span that never started`);
      if (ms < openMs) throw providerError(`the ${kind} report ends a span before it starts`);
      runs.push(spanOf(openMs, ms));
      openMs = null;
    }
  }
  if (openMs !== null) {
    if (durationMs === null) {
      throw providerError(`a ${kind} span is open at the end and the media duration is unknown`);
    }
    runs.push(spanOf(openMs, Math.max(openMs, durationMs)));
  }
  if (runs.length > MAX_DETECT_RUNS) {
    throw providerError(`the ${kind} report has more than ${MAX_DETECT_RUNS} spans`);
  }
  runs.forEach((run, index) => {
    if (index > 0 && run.startMs < runs[index - 1]!.endMs) {
      throw providerError(`the ${kind} spans overlap`);
    }
  });
  return runs;
}

/**
 * Pure: the flicker score of a luma series (values from 0 to 1, one per frame). The reversal of each frame is the change of
 * brightness step from one step to the next, halved. The largest share of reversals is dropped (a cut or a flash is not
 * flicker), and the mean of the rest is taken over DETECT_STEPS.flickerFullScaleLuma, capped at 1. A steady picture scores
 * 0, and a picture that alternates each frame scores 1. Null with fewer than three frames, since no reversal can be seen.
 */
export function flickerScoreOf(luma: readonly number[]): number | null {
  if (luma.length < 3) return null;
  const steps: number[] = [];
  for (let index = 0; index + 1 < luma.length; index++) {
    steps.push(luma[index + 1]! - luma[index]!);
  }
  const reversals: number[] = [];
  for (let index = 1; index < steps.length; index++) {
    reversals.push(Math.abs(steps[index]! - steps[index - 1]!) / 2);
  }
  reversals.sort((a, b) => a - b);
  const kept = reversals.slice(
    0,
    reversals.length - Math.floor(reversals.length * DETECT_STEPS.flickerTrimShare),
  );
  const mean = kept.reduce((sum, value) => sum + value, 0) / kept.length;
  return Math.min(1, mean / DETECT_STEPS.flickerFullScaleLuma);
}

/** Pure: the mean of a motion series (values from 0 to 1), or null when there are none. */
export function meanMotionOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function checkDuration(durationMs: number | null): void {
  if (durationMs !== null && durationMs > FFMPEG_LIMITS.maxDetectMs) {
    throw new EngineError(
      "invalid_input",
      `the media is ${durationMs} ms, above the ${FFMPEG_LIMITS.maxDetectMs} ms detector limit`,
      { stage: STAGE },
    );
  }
}

/** Black and frozen runs of the first video stream. No video stream is reported as no video, never as no runs. */
export async function blackFramesRun(
  request: DetectRequest,
  options: DetectorRunOptions = {},
): Promise<BlackFramesResult> {
  const input = parseInput(detectRequestSchema, request, STAGE);
  return withWorkdir(async (dir) => {
    const media = await materialise(input.source, dir, options);
    const probe = await probeFile(media.path, media.bytes, options);
    checkDuration(probe.durationMs);
    const fps = probe.fps?.value ?? null;
    if (probe.videoCodec === null) {
      return {
        videoPresent: false,
        durationMs: probe.durationMs,
        fps,
        blackRuns: [],
        frozenRuns: [],
      };
    }
    const output = await runTool("ffmpeg", blackFramesArgs(media.path), {
      timeoutMs: FFMPEG_LIMITS.toolTimeoutMs.black,
      stage: STAGE,
      paths: options.paths,
    });
    return {
      videoPresent: true,
      durationMs: probe.durationMs,
      fps,
      blackRuns: parseSpans(output.stderr, "black", probe.durationMs),
      frozenRuns: parseSpans(output.stderr, "freeze", probe.durationMs),
    };
  });
}

/** Flicker of the first video stream (Bible 12.2). */
export async function flickerRun(
  request: DetectRequest,
  options: DetectorRunOptions = {},
): Promise<FlickerResult> {
  const input = parseInput(detectRequestSchema, request, STAGE);
  return withWorkdir(async (dir) => {
    const media = await materialise(input.source, dir, options);
    const probe = await probeFile(media.path, media.bytes, options);
    checkDuration(probe.durationMs);
    if (probe.videoCodec === null) return { videoPresent: false, frames: 0, flickerScore: null };
    const output = await runTool("ffmpeg", lumaArgs(media.path), {
      timeoutMs: FFMPEG_LIMITS.toolTimeoutMs.flicker,
      stage: STAGE,
      paths: options.paths,
    });
    const luma = parseSignalSeries(output.stderr, 255).map((sample) => sample.value);
    return { videoPresent: true, frames: luma.length, flickerScore: flickerScoreOf(luma) };
  });
}

/** Motion energy of the first video stream (Bible 12.2, the motion check). */
export async function motionRun(
  request: DetectRequest,
  options: DetectorRunOptions = {},
): Promise<MotionResult> {
  const input = parseInput(detectRequestSchema, request, STAGE);
  return withWorkdir(async (dir) => {
    const media = await materialise(input.source, dir, options);
    const probe = await probeFile(media.path, media.bytes, options);
    checkDuration(probe.durationMs);
    if (probe.videoCodec === null) return { videoPresent: false, frames: 0, meanMotion: null };
    const output = await runTool("ffmpeg", motionEnergyArgs(media.path), {
      timeoutMs: FFMPEG_LIMITS.toolTimeoutMs.motion,
      stage: STAGE,
      paths: options.paths,
    });
    const values = parseSignalSeries(output.stderr, 255).map((sample) => sample.value);
    return { videoPresent: true, frames: values.length, meanMotion: meanMotionOf(values) };
  });
}

/** Silent spans of the first audio stream (Bible 8.1, 12.3). No audio stream is reported as no audio, with no longest span. */
export async function silenceRun(
  request: DetectRequest,
  options: DetectorRunOptions = {},
): Promise<SilenceResult> {
  const input = parseInput(detectRequestSchema, request, STAGE);
  return withWorkdir(async (dir) => {
    const media = await materialise(input.source, dir, options);
    const probe = await probeFile(media.path, media.bytes, options);
    checkDuration(probe.durationMs);
    if (!probe.audioPresent) {
      return {
        audioPresent: false,
        durationMs: probe.durationMs,
        minSilenceMs: DETECT_STEPS.minSilenceMs,
        silences: [],
        longestMs: null,
      };
    }
    const output = await runTool("ffmpeg", silenceArgs(media.path), {
      timeoutMs: FFMPEG_LIMITS.toolTimeoutMs.silence,
      stage: STAGE,
      paths: options.paths,
    });
    const silences = parseSpans(output.stderr, "silence", probe.durationMs);
    return {
      audioPresent: true,
      durationMs: probe.durationMs,
      minSilenceMs: DETECT_STEPS.minSilenceMs,
      silences,
      longestMs: silences.reduce((most, run) => Math.max(most, run.durationMs), 0),
    };
  });
}
