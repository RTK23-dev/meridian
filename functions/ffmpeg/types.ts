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

const timelineSampleSchema = z.strictObject({
  atMs: z.int().nonnegative(),
  value: z.number().min(0).max(1).finite(),
});
const loudnessSampleSchema = z.strictObject({
  atMs: z.int().nonnegative(),
  lufs: z.number().finite().nullable(),
});

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

/**
 * The picture measures (Bible 6.2 step 6, 8.1 motion and endsOnLoop): a grayscale thumbnail every sampleMs, the scale that
 * maps each thumbnail onto the next, and the difference between the first and the true last frame. Initial values.
 */
export const PICTURE_STEPS = {
  /** The spacing of the thumbnails, and so of the scale pairs. A zoom jump is caught by the pair that holds it. */
  sampleMs: 100,
  /** Width of each thumbnail in pixels. The height follows the picture's aspect ratio. */
  thumbWidthPx: 64,
  /** The window at the end of the picture from which the last frame is read. */
  tailWindowMs: 500,
} as const;

/** At most this many scene cuts per call (a reference of 90 s has far fewer). */
export const MAX_PICTURE_CUTS = 600;
/** At most this many pairs per call: the longest picture (240 s) at one pair per sampleMs. */
export const MAX_PICTURE_PAIRS = 2400;

const pictureScaleSchema = z.number().finite().min(0.5).max(2);

/**
 * One pair of neighbouring thumbnails: atMs is the time of the later one. A pair that straddles a scene cut is not measured
 * (usable false). A measured pair has the scale that maps the earlier thumbnail onto the later one (new over old, so a
 * zoom-in is above 1), and fit: the share of the frame difference that this scale leaves (0 is a perfect fit, 1 is no gain).
 */
export const picturePairSchema = z
  .strictObject({
    atMs: z.int().nonnegative(),
    usable: z.boolean(),
    scale: pictureScaleSchema.nullable(),
    fit: z.number().finite().min(0).max(1).nullable(),
  })
  .refine(
    (pair) =>
      pair.usable
        ? pair.scale !== null && pair.fit !== null
        : pair.scale === null && pair.fit === null,
    { message: "a pair is usable with a scale and a fit, or unusable with neither" },
  );
export type PicturePair = z.infer<typeof picturePairSchema>;

export const pictureRequestSchema = z.strictObject({
  source: mediaSourceSchema,
  /** Scene-cut times in milliseconds (from the cuts function). A pair that straddles one is not measured. */
  cutsMs: z.array(z.int().nonnegative()).max(MAX_PICTURE_CUTS),
});
export type PictureRequest = z.infer<typeof pictureRequestSchema>;

/**
 * One call's measures. loopDistance is the mean luma difference between the first frame and the last frame (0 to 1), or null
 * when the picture is too short to hold two thumbnails.
 */
export const pictureResultSchema = z.strictObject({
  sampleMs: z.literal(PICTURE_STEPS.sampleMs),
  width: z.int().positive(),
  height: z.int().positive(),
  pairs: z
    .array(picturePairSchema)
    .max(MAX_PICTURE_PAIRS)
    .refine(
      (pairs) => pairs.every((pair, index) => index === 0 || pair.atMs > pairs[index - 1]!.atMs),
      {
        message: "pairs must run forward in time",
      },
    ),
  loopDistance: z.number().finite().min(0).max(1).nullable(),
});
export type PictureResult = z.infer<typeof pictureResultSchema>;

/**
 * The detectors (Bible 6.7 step 1, 12.2, 12.3): black and frozen frames, flicker, motion and silence. Each is one stateless
 * ffmpeg pass over the media. Initial values; the consumers' limits are read from configuration, not here.
 */
export const DETECT_STEPS = {
  /** blackdetect (pix_th): a pixel is black at or below this luma share (0 to 1). */
  blackPixelThreshold: 0.1,
  /** blackdetect (pic_th): a frame is black when this share of its pixels is black. */
  blackPictureThreshold: 0.98,
  /** freezedetect (noise): two frames are the same when their difference is at most this (0 to 1). */
  freezeNoise: 0.001,
  /** silencedetect (noise): audio at or below this level is silent, in dBFS. The analyze stage uses the same floor (Bible 8.1). */
  silenceNoiseDb: -50,
  /** silencedetect (d): silences shorter than this are not reported. */
  minSilenceMs: 100,
  /** flicker: the largest share of reversals dropped before the mean (a cut or a flash is not flicker). */
  flickerTrimShare: 0.1,
  /** flicker: a mean reversal of this much luma per frame (0 to 1) scores 1. */
  flickerFullScaleLuma: 0.05,
} as const;

/** At most this many runs per call. A 240 s reel with a run every frame would exceed it, which is refused. */
export const MAX_DETECT_RUNS = 2000;

export const detectRequestSchema = z.strictObject({ source: mediaSourceSchema });
export type DetectRequest = z.infer<typeof detectRequestSchema>;

/** A time span in whole milliseconds: from startMs to endMs, with durationMs the difference. */
export const detectRunSchema = z
  .strictObject({
    startMs: z.int().nonnegative(),
    endMs: z.int().nonnegative(),
    durationMs: z.int().nonnegative(),
  })
  .refine((run) => run.endMs >= run.startMs && run.durationMs === run.endMs - run.startMs, {
    message: "a run ends at or after its start, and its duration is the difference of the two",
  });
export type DetectRun = z.infer<typeof detectRunSchema>;

const detectRunsSchema = z
  .array(detectRunSchema)
  .max(MAX_DETECT_RUNS)
  .refine(
    (runs) => runs.every((run, index) => index === 0 || run.startMs >= runs[index - 1]!.endMs),
    {
      message: "runs must be in time order and must not overlap",
    },
  );

/**
 * Black and frozen runs. A run is a span whose frames are black (blackdetect) or identical (freezedetect). The runs are the
 * ffmpeg report, so a single black frame is a run of one frame's duration. fps is the probed frame rate, so a consumer can
 * count frames. A video with no video stream reports no runs and says so.
 */
export const blackFramesResultSchema = z
  .strictObject({
    videoPresent: z.boolean(),
    durationMs: z.int().nonnegative().nullable(),
    fps: z.number().positive().finite().nullable(),
    blackRuns: detectRunsSchema,
    frozenRuns: detectRunsSchema,
  })
  .refine(
    (result) =>
      result.videoPresent || (result.blackRuns.length === 0 && result.frozenRuns.length === 0),
    {
      message: "a media with no video has no black or frozen runs",
    },
  );
export type BlackFramesResult = z.infer<typeof blackFramesResultSchema>;

/**
 * Flicker (Bible 12.2, normalised): the mean reversal of frame-to-frame brightness, after dropping the largest reversals, over
 * DETECT_STEPS.flickerFullScaleLuma, capped at 1. Brightness only, not motion-compensated. frames is the number of luma values
 * measured. A score is null when there is no video or too few frames to see a reversal.
 */
export const flickerResultSchema = z
  .strictObject({
    videoPresent: z.boolean(),
    frames: z.int().nonnegative(),
    flickerScore: z.number().min(0).max(1).finite().nullable(),
  })
  .refine(
    (result) => result.videoPresent || (result.flickerScore === null && result.frames === 0),
    {
      message: "a media with no video has no flicker score",
    },
  );
export type FlickerResult = z.infer<typeof flickerResultSchema>;

/**
 * Motion energy: the mean absolute luma change between consecutive frames, on a 0 to 1 scale. It is a frame difference, not
 * optical flow, so its scale differs from the Bible's flow value and its limit is a calibrated initial value (config).
 */
export const motionResultSchema = z
  .strictObject({
    videoPresent: z.boolean(),
    frames: z.int().nonnegative(),
    meanMotion: z.number().min(0).max(1).finite().nullable(),
  })
  .refine((result) => result.videoPresent || (result.meanMotion === null && result.frames === 0), {
    message: "a media with no video has no motion",
  });
export type MotionResult = z.infer<typeof motionResultSchema>;

/**
 * Silence (Bible 8.1, 12.3): the silent spans of the first audio stream, each at least minSilenceMs long. longestMs is the
 * longest of them, or 0 when the audio has none that long. With no audio stream, nothing is measured: longestMs is null.
 */
export const silenceResultSchema = z
  .strictObject({
    audioPresent: z.boolean(),
    durationMs: z.int().nonnegative().nullable(),
    minSilenceMs: z.literal(DETECT_STEPS.minSilenceMs),
    silences: detectRunsSchema,
    longestMs: z.int().nonnegative().nullable(),
  })
  .refine(
    (result) => {
      if (!result.audioPresent) return result.silences.length === 0 && result.longestMs === null;
      const longest = result.silences.reduce((most, run) => Math.max(most, run.durationMs), 0);
      return result.longestMs === longest;
    },
    { message: "longestMs is the longest silence, 0 when none, and null with no audio stream" },
  );
export type SilenceResult = z.infer<typeof silenceResultSchema>;
