// timeline: per-sample measures of one reference video in one call (Bible 6.2 step 2). Brightness and motion every 500 ms
// (signalstats on a 160 px wide copy; motion is the mean luma change to the sample 500 ms earlier), momentary loudness
// every 100 ms (ebur128 metadata, BS.1770 gate), and a mono RMS envelope every 10 ms from 8 kHz PCM, which the beat grid
// is computed from in src/engine/analyze. Each series is one ffmpeg run whose output this file parses. The parsers are
// pure and exported for tests. Nothing here decides a value: a missing measure is an error, never a default.

import { EngineError } from "../../src/engine/contracts/errors.ts";
import { runTool, type ToolPaths } from "./exec.ts";
import { FFMPEG_LIMITS } from "./limits.ts";
import { probeFile } from "./probe.ts";
import { materialise, withWorkdir, type SourceOptions } from "./source.ts";
import {
  LOUDNESS_GATE_LUFS,
  TIMELINE_STEPS,
  timelineRequestSchema,
  parseInput,
  type LoudnessSample,
  type TimelineRequest,
  type TimelineResult,
  type TimelineSample,
} from "./types.ts";

const STAGE = "media.timeline";
const SIGNAL_KEY = "lavfi.signalstats.YAVG";
const LOUDNESS_KEY = "lavfi.r128.M";
/** Width of the copy the brightness and motion are measured on. Small enough to be cheap, large enough to see a change. */
const MEASURE_WIDTH_PX = 160;

export type TimelineRunOptions = SourceOptions & { paths?: ToolPaths };

const COMMON = ["-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", "-i"] as const;

/** Pure: arguments that print the mean luma of each sample (0 to 255) to stderr. */
export function brightnessArgs(inputPath: string): string[] {
  const sampling = `fps=${1000 / TIMELINE_STEPS.videoSampleMs},scale=${MEASURE_WIDTH_PX}:-2`;
  return [
    ...COMMON,
    inputPath,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    `${sampling},signalstats,metadata=mode=print:key=${SIGNAL_KEY}`,
    "-f",
    "null",
    "-",
  ];
}

/** Pure: arguments that print the mean absolute luma change to the sample one step earlier (0 to 255) to stderr. */
export function motionArgs(inputPath: string): string[] {
  const sampling = `fps=${1000 / TIMELINE_STEPS.videoSampleMs},scale=${MEASURE_WIDTH_PX}:-2`;
  return [
    ...COMMON,
    inputPath,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    `${sampling},tblend=all_mode=difference,signalstats,metadata=mode=print:key=${SIGNAL_KEY}`,
    "-f",
    "null",
    "-",
  ];
}

/** Pure: arguments that print the momentary loudness of each 100 ms step to stderr. */
export function loudnessArgs(inputPath: string): string[] {
  return [
    ...COMMON,
    inputPath,
    "-map",
    "0:a:0",
    "-vn",
    "-filter_complex",
    `[0:a:0]ebur128=metadata=1:framelog=quiet,ametadata=mode=print:key=${LOUDNESS_KEY}[measured]`,
    "-map",
    "[measured]",
    "-f",
    "null",
    "-",
  ];
}

/** Pure: arguments that write the first audio stream as mono signed 16-bit PCM at 8 kHz to stdout. */
export function pcmArgs(inputPath: string): string[] {
  return [
    "-nostdin",
    "-hide_banner",
    "-nostats",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(TIMELINE_STEPS.envelopeSampleRateHz),
    "-f",
    "s16le",
    "-acodec",
    "pcm_s16le",
    "pipe:1",
  ];
}

const FRAME_LINE = /frame:\s*\d+\s+pts:\s*\S+\s+pts_time:(-?\d+(?:\.\d+)?)/;

function toMs(seconds: string): number {
  const ms = Math.round(Number(seconds) * 1000);
  if (!Number.isFinite(ms) || ms < 0) {
    throw new EngineError("provider", "a timeline sample has a negative or non-numeric time", {
      stage: STAGE,
    });
  }
  return ms;
}

/**
 * Pure: reads one metadata series from stderr. Each sample is a frame line (its time) followed by a value line. A value
 * with no time, or a time with no value, is a provider error: the series is refused, not shortened.
 */
export function parseSignalSeries(stderr: string, scale: number): TimelineSample[] {
  const samples: TimelineSample[] = [];
  let pendingMs: number | null = null;
  const valueLine = new RegExp(`${SIGNAL_KEY.replace(/\./g, "\\.")}=(-?\\d+(?:\\.\\d+)?)`);
  for (const line of stderr.split("\n")) {
    const frame = FRAME_LINE.exec(line);
    if (frame) {
      if (pendingMs !== null) {
        throw new EngineError("provider", "a timeline frame has no value line", { stage: STAGE });
      }
      pendingMs = toMs(frame[1] ?? "");
      continue;
    }
    const value = valueLine.exec(line);
    if (value) {
      if (pendingMs === null) {
        throw new EngineError("provider", "a timeline value has no frame time", { stage: STAGE });
      }
      const raw = Number(value[1]);
      samples.push({ atMs: pendingMs, value: Math.min(1, Math.max(0, raw / scale)) });
      pendingMs = null;
    }
  }
  if (pendingMs !== null) {
    throw new EngineError("provider", "the last timeline frame has no value line", {
      stage: STAGE,
    });
  }
  return samples;
}

/** Pure: reads the momentary loudness series. "-inf" and values at or below the gate are null (silence, Bible 8.1). */
export function parseLoudnessSeries(stderr: string): LoudnessSample[] {
  const samples: LoudnessSample[] = [];
  let pendingMs: number | null = null;
  const valueLine = new RegExp(`${LOUDNESS_KEY.replace(/\./g, "\\.")}=(-?\\d+(?:\\.\\d+)?|-inf)`);
  for (const line of stderr.split("\n")) {
    const frame = FRAME_LINE.exec(line);
    if (frame) {
      if (pendingMs !== null) {
        throw new EngineError("provider", "a loudness frame has no value line", { stage: STAGE });
      }
      pendingMs = toMs(frame[1] ?? "");
      continue;
    }
    const value = valueLine.exec(line);
    if (value) {
      if (pendingMs === null) {
        throw new EngineError("provider", "a loudness value has no frame time", { stage: STAGE });
      }
      const text = value[1] ?? "-inf";
      const lufs = text === "-inf" ? null : Number(text);
      samples.push({
        atMs: pendingMs,
        lufs: lufs === null || lufs <= LOUDNESS_GATE_LUFS ? null : lufs,
      });
      pendingMs = null;
    }
  }
  if (pendingMs !== null) {
    throw new EngineError("provider", "the last loudness frame has no value line", {
      stage: STAGE,
    });
  }
  return samples;
}

/**
 * Pure: the RMS envelope of mono 16-bit PCM, one value per 10 ms window (0 to 1, full scale is 32768). Only whole windows are
 * kept. An odd trailing byte is ignored. Silence is 0, which is a measurement, not an unknown.
 */
export function envelopeFromPcm(pcm: Uint8Array): number[] {
  const windowSamples =
    (TIMELINE_STEPS.envelopeSampleRateHz * TIMELINE_STEPS.envelopeStepMs) / 1000;
  const samples = Math.floor(pcm.byteLength / 2);
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
  const rms: number[] = [];
  for (let start = 0; start + windowSamples <= samples; start += windowSamples) {
    let sum = 0;
    for (let i = start; i < start + windowSamples; i++) {
      const sample = view.getInt16(i * 2, true) / 32768;
      sum += sample * sample;
    }
    rms.push(Math.min(1, Math.sqrt(sum / windowSamples)));
  }
  return rms;
}

/** Runs the timeline on a source: probes the streams, runs one ffmpeg pass per series, and cleans up. */
export async function run(
  request: TimelineRequest,
  options: TimelineRunOptions = {},
): Promise<TimelineResult> {
  const input = parseInput(timelineRequestSchema, request, STAGE);
  return withWorkdir(async (dir) => {
    const media = await materialise(input.source, dir, options);
    const probe = await probeFile(media.path, media.bytes, options);
    if (probe.durationMs !== null && probe.durationMs > FFMPEG_LIMITS.maxTimelineMs) {
      throw new EngineError(
        "invalid_input",
        `the media is ${probe.durationMs} ms, above the ${FFMPEG_LIMITS.maxTimelineMs} ms timeline limit`,
        { stage: STAGE },
      );
    }
    const videoPresent = probe.videoCodec !== null;
    const audioPresent = probe.audioPresent;
    const tool = (args: string[]) =>
      runTool("ffmpeg", args, {
        timeoutMs: FFMPEG_LIMITS.toolTimeoutMs.timeline,
        stage: STAGE,
        paths: options.paths,
      });

    const brightness = videoPresent
      ? parseSignalSeries((await tool(brightnessArgs(media.path))).stderr, 255)
      : [];
    const motion = videoPresent
      ? parseSignalSeries((await tool(motionArgs(media.path))).stderr, 255)
      : [];
    const loudness = audioPresent
      ? parseLoudnessSeries((await tool(loudnessArgs(media.path))).stderr)
      : [];
    const envelope = audioPresent ? envelopeFromPcm((await tool(pcmArgs(media.path))).stdout) : [];
    return {
      videoPresent,
      audioPresent,
      brightness,
      motion,
      loudness,
      envelope: { stepMs: TIMELINE_STEPS.envelopeStepMs, rms: envelope },
    };
  });
}
