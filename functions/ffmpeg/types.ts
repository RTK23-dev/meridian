// Typed inputs and outputs of the media functions (Bible 6.2, 6.6, 6.11, 8.1, 12.2, 12.3). This is the in-process form,
// where media is a Uint8Array. wire.ts carries the same data as base64 over HTTP.

import { z, type ZodType } from "zod";
import { EngineError } from "../../src/engine/contracts/errors.ts";
import { thresholds } from "../../src/engine/config/thresholds.ts";
import { FFMPEG_LIMITS } from "./limits.ts";

/** At most this many frames per call (Bible 6.2: cap 60). Read from configuration. */
export const MAX_FRAMES_PER_CALL: number = thresholds.reference.maxFrames;

export const mediaUrlSchema = z.url().max(2048);

/** Where the media comes from: a URL the function fetches itself, or bytes passed in (tests and small inputs). */
export const mediaSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("url"), url: mediaUrlSchema }),
  z.strictObject({ kind: z.literal("bytes"), bytes: z.instanceof(Uint8Array) }),
]);
export type MediaSource = z.infer<typeof mediaSourceSchema>;

const uniqueInts = (values: readonly number[]): boolean => new Set(values).size === values.length;

export const probeRequestSchema = z.strictObject({ source: mediaSourceSchema });
export type ProbeRequest = z.infer<typeof probeRequestSchema>;

/** Probe of the first video stream and the first audio stream. Unknown values are null, never guessed. */
export const probeResultSchema = z.strictObject({
  container: z.string().min(1).nullable(),
  videoCodec: z.string().min(1).nullable(),
  audioCodec: z.string().min(1).nullable(),
  width: z.int().positive().nullable(),
  height: z.int().positive().nullable(),
  fps: z
    .strictObject({
      num: z.int().positive(),
      den: z.int().positive(),
      value: z.number().positive().finite(),
    })
    .nullable(),
  durationMs: z.int().nonnegative().nullable(),
  audioPresent: z.boolean(),
  bytes: z.int().nonnegative().nullable(),
});
export type ProbeResult = z.infer<typeof probeResultSchema>;

export const framesRequestSchema = z.strictObject({
  source: mediaSourceSchema,
  atMs: z
    .array(z.int().nonnegative())
    .min(1)
    .max(MAX_FRAMES_PER_CALL)
    .refine(uniqueInts, { message: "atMs must be unique" }),
  longSidePx: z.int().min(64).max(2160).optional(),
});
export type FramesRequest = z.infer<typeof framesRequestSchema>;

/** One frame: the first decoded frame at or after atMs, as a PNG. */
export const frameSchema = z.strictObject({
  atMs: z.int().nonnegative(),
  width: z.int().positive(),
  height: z.int().positive(),
  png: z.instanceof(Uint8Array),
});
export type Frame = z.infer<typeof frameSchema>;

export const framesResultSchema = z.strictObject({ frames: z.array(frameSchema) });
export type FramesResult = z.infer<typeof framesResultSchema>;

export const loudnessRequestSchema = z.strictObject({ source: mediaSourceSchema });
export type LoudnessRequest = z.infer<typeof loudnessRequestSchema>;

/** EBU R128 measurements. Null means not measurable (for example silence, or no audio): unknown stays null. */
export const loudnessResultSchema = z.strictObject({
  integratedLufs: z.number().finite().nullable(),
  truePeakDbtp: z.number().finite().nullable(),
  loudnessRangeLu: z.number().nonnegative().finite().nullable(),
});
export type LoudnessResult = z.infer<typeof loudnessResultSchema>;

/** The scene score must be strictly between 0 and 1 (ffmpeg's scene score is in that range). */
export const sceneScoreSchema = z.number().gt(0).lt(1).finite();

export const cutsRequestSchema = z.strictObject({
  source: mediaSourceSchema,
  sceneScore: sceneScoreSchema,
});
export type CutsRequest = z.infer<typeof cutsRequestSchema>;

/** Scene-change timestamps in integer milliseconds, ascending and unique. */
export const cutsResultSchema = z.strictObject({
  cutsMs: z
    .array(z.int().nonnegative())
    .refine((values) => values.every((value, i) => i === 0 || value > values[i - 1]!), {
      message: "cutsMs must be ascending and unique",
    }),
});
export type CutsResult = z.infer<typeof cutsResultSchema>;

/**
 * Validates a value at a function boundary. A failure is an invalid_input error that names the failing fields. It is
 * never a silent default.
 */
export function parseInput<Body>(schema: ZodType<Body>, value: unknown, stage: string): Body {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.map(String).join(".") || "input"}: ${issue.message}`)
      .join("; ");
    throw new EngineError("invalid_input", `invalid media request: ${detail}`, { stage });
  }
  return parsed.data;
}

/** Byte-size check for input media (before anything is written to the temporary directory). */
export function assertInputSize(bytes: number, stage: string): void {
  if (bytes === 0) {
    throw new EngineError("invalid_input", "the media is empty", { stage });
  }
  if (bytes > FFMPEG_LIMITS.maxInputBytes) {
    throw new EngineError(
      "invalid_input",
      `the media is ${bytes} bytes, above the ${FFMPEG_LIMITS.maxInputBytes} byte limit`,
      {
        stage,
      },
    );
  }
}

/**
 * The timeline (Bible 6.2 step 2): per-sample measures of one video, from one call. Each series keeps its own step, and
 * every sample time is an integer millisecond from the start. Unknown stays null: a silent measure is a null loudness.
 */
export const TIMELINE_STEPS = {
  /** Brightness and motion: two samples per second (the frame rate of the reference sample, Bible 6.2). */
  videoSampleMs: 500,
  /** Momentary loudness (EBU R128, 400 ms window) every 100 ms. */
  loudnessStepMs: 100,
  /** The audio envelope: mono RMS over each 10 ms window. */
  envelopeStepMs: 10,
  /** The PCM rate the envelope is taken from. */
  envelopeSampleRateHz: 8000,
} as const;

/** Momentary loudness at or below the BS.1770 absolute gate is reported as null (silence, Bible 8.1). */
export const LOUDNESS_GATE_LUFS = -70;

export const timelineRequestSchema = z.strictObject({ source: mediaSourceSchema });
export type TimelineRequest = z.infer<typeof timelineRequestSchema>;

const timelineSampleSchema = z.strictObject({ atMs: z.int().nonnegative(), value: z.number().min(0).max(1).finite() });
const loudnessSampleSchema = z.strictObject({ atMs: z.int().nonnegative(), lufs: z.number().finite().nullable() });

/** One call's measures. Series are empty when the stream is absent (videoPresent or audioPresent false). */
export const timelineResultSchema = z.strictObject({
  videoPresent: z.boolean(),
  audioPresent: z.boolean(),
  brightness: z.array(timelineSampleSchema).max(600),
  motion: z.array(timelineSampleSchema).max(600),
  loudness: z.array(loudnessSampleSchema).max(3000),
  envelope: z.strictObject({
    stepMs: z.literal(TIMELINE_STEPS.envelopeStepMs),
    rms: z.array(z.number().min(0).max(1).finite()).max(30000),
  }),
});
export type TimelineResult = z.infer<typeof timelineResultSchema>;
export type TimelineSample = z.infer<typeof timelineSampleSchema>;
export type LoudnessSample = z.infer<typeof loudnessSampleSchema>;
