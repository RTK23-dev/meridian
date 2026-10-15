// The frame_reader readings of analyze_reference (Bible 6.2 step 6, 8.1). The role reads a few sampled frames as measurements; this
// file calls it through runRole and aggregates the answers into the grammar's caption and motion fields. Frames the reader is not
// sure of count for nothing, and a field with too few confident frames is null with its reason (CLAUDE.md working rule 1). No
// text of the frames is read or stored: the role returns counts and boxes only (Bible 1, principle 4).

import { runRole, type RoleDeps, type RoleOutcome } from "../claude/client.ts";
import {
  frameReader,
  FRAME_READER_MAX_FRAMES,
  type FrameReading,
  type FrameReaderAnswer,
  type FrameReaderInput,
} from "../claude/roles/frame_reader.ts";
import { EngineError } from "../contracts/errors.ts";
import { sortedCuts, type MeasuredCaptions } from "../edit/grammar.ts";
import type { Frame, PictureClient } from "../media/index.ts";
import { analyzeConfig } from "./config.ts";
import { pictureReadings } from "./readings.ts";
import type { GrammarReadings, ReadingsScope } from "./reference.ts";

const STAGE = "analyze_reference";

/** The reading config: the numbers this file reads (analyze/config.ts). */
export type FrameReadingConfig = typeof analyzeConfig.frameReader;

/** What a call needs from its run: the tenant, the request, the reservation, the attempt and the video's timing. */
export type FrameScope = {
  organizationId: string;
  requestId: string;
  reservationId: string;
  attempt: number;
  durationMs: number;
  cutsMs: readonly number[];
};

/** One frame's reading, with the time of the frame it was read from. */
export type TimedReading = { atMs: number; reading: FrameReading };

export type FrameReadingsOutcome =
  | { status: "answered"; readings: TimedReading[] }
  /** The reservation does not cover the call, or the answer failed twice: the readings are missing, not guessed. */
  | { status: "refused"; reason: string };

/** The readings of one run as the grammar reads them. A null field carries its reason. */
export type FrameReadings = {
  captions: MeasuredCaptions | null;
  shake: boolean | null;
  speedRamps: boolean | null;
  reasons: { captions?: string; motion?: string };
};

/** The frame as the role reads it: a PNG as a base64 data URL. */
function imageUrlOf(frame: Frame): string {
  return `data:image/png;base64,${Buffer.from(frame.png).toString("base64")}`;
}

/**
 * Frames to send when there are more than the role takes: evenly spaced by position, the first and the last included. Pure. A
 * list no longer than max is returned whole.
 */
export function selectFrames(
  frames: readonly Frame[],
  max: number = FRAME_READER_MAX_FRAMES,
): Frame[] {
  if (frames.length <= max) return [...frames];
  const positions = new Set<number>();
  for (let index = 0; index < max; index++) {
    positions.add(Math.round((index * (frames.length - 1)) / (max - 1)));
  }
  return [...positions].sort((a, b) => a - b).map((position) => frames[position]!);
}

/**
 * Calls the role on the frames given (at most FRAME_READER_MAX_FRAMES; the caller selects them). One reading comes back per
 * frame, in order. A refused call is a refused outcome; a duplicate with no stored answer is a conflict, never a guess.
 */
export async function readFrames(
  roles: RoleDeps,
  scope: FrameScope,
  frames: readonly Frame[],
): Promise<FrameReadingsOutcome> {
  if (frames.length === 0) return { status: "refused", reason: "no frames were sent" };
  const input: FrameReaderInput = {
    durationMs: scope.durationMs,
    cutsMs: sortedCuts(scope.durationMs, scope.cutsMs),
    frames: frames.map((frame) => ({ atMs: frame.atMs, imageUrl: imageUrlOf(frame) })),
  };
  const outcome: RoleOutcome<FrameReaderAnswer> = await runRole(roles, frameReader, {
    requestId: scope.requestId,
    workspaceId: scope.organizationId,
    reservationId: scope.reservationId,
    attempt: scope.attempt,
    input,
  });
  if (outcome.status === "refused") return { status: "refused", reason: outcome.reason };
  if (outcome.status === "duplicate") {
    throw new EngineError(
      "conflict",
      `${outcome.role} was already authorized for this job and no answer is stored; reuse the stored answer`,
      { stage: STAGE },
    );
  }
  return {
    status: "answered",
    readings: frames.map((frame, index) => ({
      atMs: frame.atMs,
      reading: outcome.value.frames[index]!,
    })),
  };
}

/** The band a caption falls in, from the centre of its box. */
export function bandOf(
  box: { y: number; h: number },
  band: FrameReadingConfig["captionBand"],
): "upper" | "middle" | "lower" {
  const centre = box.y + box.h / 2;
  if (centre < band.upperBelow) return "upper";
  if (centre > band.lowerAbove) return "lower";
  return "middle";
}

/** The most common value, or null when two values are tied for the most (a split is not a reading). */
export function majority<Value extends string>(values: readonly Value[]): Value | null {
  const counts = new Map<Value, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  if (ranked.length > 1 && ranked[0]![1] === ranked[1]![1]) return null;
  return ranked[0]![0];
}

/**
 * The caption block (Bible 8.1, captions): the words per caption as the least and the most seen, the band, the style and whether
 * one word is highlighted, from the confident frames that show a caption. Null with a reason when there are too few such frames,
 * when the band or the style is split, or when no frame says whether a word is highlighted.
 */
export function captionsOf(
  readings: readonly TimedReading[],
  config: FrameReadingConfig = analyzeConfig.frameReader,
): { captions: MeasuredCaptions | null; reason: string | null } {
  const withCaptions = readings.filter(
    (item) => item.reading.confidence >= config.minConfidence && item.reading.captions.length > 0,
  );
  if (withCaptions.length < config.minCaptionFrames) {
    return {
      captions: null,
      reason: `fewer than ${config.minCaptionFrames} confident frames show a caption (${withCaptions.length} of ${readings.length} frames)`,
    };
  }
  const boxes = withCaptions.flatMap((item) => item.reading.captions);
  const position = majority(boxes.map((box) => bandOf(box.box, config.captionBand)));
  if (position === null)
    return { captions: null, reason: "the caption band is split between frames" };
  const style = majority(boxes.map((box) => box.style));
  if (style === null)
    return { captions: null, reason: "the caption style is split between frames" };
  const definite = boxes.filter((box) => box.highlight !== "unclear");
  if (definite.length === 0) {
    return { captions: null, reason: "no caption frame says whether one word is highlighted" };
  }
  const highlighted = definite.filter((box) => box.highlight === "one_word").length;
  const plain = definite.length - highlighted;
  if (highlighted === plain)
    return { captions: null, reason: "the highlight of the current word is split" };
  const words = boxes.map((box) => box.words);
  return {
    captions: {
      wordsPerCaption: [Math.min(...words), Math.max(...words)],
      position,
      style,
      highlightCurrentWord: highlighted > plain,
    },
    reason: null,
  };
}

/**
 * One motion judgement (shake or speed ramp) as a flag. The share of the sampled frames that were judged clearly must reach
 * minJudgedShare, or the flag is null. The flag is set when the share of judged frames that show it reaches shareMin.
 */
export function judgementOf(
  readings: readonly TimedReading[],
  pick: (reading: FrameReading) => FrameReading["shake"],
  shareMin: number,
  config: FrameReadingConfig = analyzeConfig.frameReader,
): { value: boolean | null; reason: string | null } {
  if (readings.length === 0) return { value: null, reason: "no frames were read" };
  const judged = readings.filter(
    (item) => item.reading.confidence >= config.minConfidence && pick(item.reading) !== "unclear",
  );
  if (judged.length / readings.length < config.minJudgedShare) {
    return {
      value: null,
      reason: `only ${judged.length} of ${readings.length} frames are judged clearly (at least ${config.minJudgedShare} needed)`,
    };
  }
  const present = judged.filter((item) => pick(item.reading) === "present").length;
  return { value: present / judged.length >= shareMin, reason: null };
}

/** The readings of one run as the grammar reads them (Bible 8.1). A refused call leaves every field null, with its reason. */
export function summariseFrameReadings(
  outcome: FrameReadingsOutcome,
  config: FrameReadingConfig = analyzeConfig.frameReader,
): FrameReadings {
  if (outcome.status === "refused") {
    const reason = `frame_reader gave no reading: ${outcome.reason}`;
    return {
      captions: null,
      shake: null,
      speedRamps: null,
      reasons: { captions: reason, motion: reason },
    };
  }
  const captions = captionsOf(outcome.readings, config);
  const shake = judgementOf(
    outcome.readings,
    (reading) => reading.shake,
    config.shakeShareMin,
    config,
  );
  const speed = judgementOf(
    outcome.readings,
    (reading) => reading.speedRamp,
    config.speedRampShareMin,
    config,
  );
  const motion = [
    shake.reason === null ? null : `shake: ${shake.reason}`,
    speed.reason === null ? null : `speed ramps: ${speed.reason}`,
  ].filter((part): part is string => part !== null);
  return {
    captions: captions.captions,
    shake: shake.value,
    speedRamps: speed.value,
    reasons: {
      ...(captions.reason === null ? {} : { captions: captions.reason }),
      ...(motion.length === 0 ? {} : { motion: motion.join("; ") }),
    },
  };
}

/** The frame_reader readings of one analysis: the selected frames, one call, then the aggregation. */
export async function frameReadingsFor(
  roles: RoleDeps,
  scope: ReadingsScope,
): Promise<FrameReadings> {
  const outcome = await readFrames(roles, scope, selectFrames(scope.frames));
  return summariseFrameReadings(outcome);
}

/**
 * The readings port of analyze_reference (reference.ts step 7), built from the picture measures (zoom jumps and the loop) and the
 * frame_reader readings (captions, shake and speed ramps). The jobs wiring passes this as ReferencePorts.readings. A failed picture
 * call throws, so the stage fails; a refused frame_reader call leaves its fields null, so the gate fails with the reason.
 */
export function analysisReadings(options: {
  picture: PictureClient;
  roles: RoleDeps;
}): (scope: ReadingsScope) => Promise<GrammarReadings> {
  const fromPicture = pictureReadings(options.picture);
  return async (scope) => {
    const pictures = await fromPicture(scope);
    const frames = await frameReadingsFor(options.roles, scope);
    const reasons: GrammarReadings["reasons"] = {
      ...(frames.reasons.captions === undefined ? {} : { captions: frames.reasons.captions }),
      ...(frames.reasons.motion === undefined ? {} : { motion: frames.reasons.motion }),
    };
    return {
      captions: frames.captions,
      zoom:
        pictures.zoom === null
          ? null
          : { jumps: pictures.zoom.jumps, shake: frames.shake, speedRamps: frames.speedRamps },
      loop: pictures.loop,
      reasons,
    };
  };
}
