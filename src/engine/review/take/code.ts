// Code checks of check_take (Bible 6.7 step 1, 12.2): duration within tolerance of the shot, no black or frozen frames,
// flicker below its limit, and motion present for a motion shot. Pure. The measurements come from the media functions
// (probe for the duration; frame differences, flicker and optical flow are not functions yet, so they arrive as recorded
// values in tests). Every limit is read from config/thresholds.ts. A null or unreadable measurement is missing evidence:
// the row fails with "not evaluated", and it routes to review rather than passing (Bible 12).

import { z } from "zod";
import { thresholds } from "../../config/thresholds.ts";
import { check, notEvaluated } from "../gates/common.ts";
import type { TakeRow } from "./types.ts";

/** The measurements of one take. Each is null when it was not measured. */
export const takeMeasurementsSchema = z.object({
  /** ffprobe duration of the take file, in integer milliseconds (media probe). */
  durationMs: z.int().nonnegative().nullable(),
  /** The longest run of black or frozen frames, in frames (frame differences). */
  blackOrFrozenRunFrames: z.int().nonnegative().nullable(),
  /** Mean frame-to-frame brightness variance after motion compensation, normalised (Bible 12.2). */
  flickerScore: z.number().finite().nonnegative().nullable(),
  /** Mean optical flow, normalised (Bible 12.2). */
  meanMotion: z.number().finite().nonnegative().nullable(),
});
export type TakeMeasurements = z.infer<typeof takeMeasurementsSchema>;

/** The shot facts the code checks need. */
export type CodeShot = { plannedDurationMs: number; motionRequired: boolean };

export const CODE_RULES = {
  duration: "duration_within_tolerance",
  blackFrames: "no_black_or_frozen_frames",
  flicker: "flicker_below_max",
  motion: "motion_present",
} as const;

function measured(rowCheck: ReturnType<typeof check>, gold: TakeRow["gold"]): TakeRow {
  return { check: rowCheck, evidence: "measured", gold };
}

function missing(rule: string, gold: TakeRow["gold"], why: string): TakeRow {
  return { check: notEvaluated(rule, why), evidence: "missing", gold };
}

function issuesOf(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "measurements"}: ${issue.message}`)
    .join("; ");
}

/** Duration (Bible 12.2): the take's ffprobe duration within the tolerance share of the shot's planned duration. */
function durationRow(plannedMs: number, measuredMs: number | null): TakeRow {
  const rule = CODE_RULES.duration;
  const gold = "take:duration_within_tolerance";
  if (measuredMs === null) return missing(rule, gold, "the take's duration was not measured");
  const tolerance = thresholds.take.durationTolerance.value;
  const deviation = Math.abs(measuredMs - plannedMs) / plannedMs;
  return measured(
    check(rule, deviation <= tolerance, {
      value: deviation,
      limit: tolerance,
      detail: `take ${measuredMs} ms against shot ${plannedMs} ms`,
    }),
    gold,
  );
}

/** Black or frozen frames (Bible 12.2): no run longer than the limit (2 frames at the initial value). */
function blackFramesRow(runFrames: number | null): TakeRow {
  const rule = CODE_RULES.blackFrames;
  const gold = "take:no_black_or_frozen_frames";
  if (runFrames === null) return missing(rule, gold, "the black and frozen frame run was not measured");
  const limit = thresholds.take.blackOrFrozenFramesMax.value;
  return measured(
    check(rule, runFrames <= limit, {
      value: runFrames,
      limit,
      detail: `longest black or frozen run is ${runFrames} frames`,
    }),
    gold,
  );
}

/** Flicker (Bible 12.2): strictly below the limit. */
function flickerRow(score: number | null): TakeRow {
  const rule = CODE_RULES.flicker;
  const gold = "take:flicker_below_max";
  if (score === null) return missing(rule, gold, "the flicker score was not measured");
  const limit = thresholds.take.flickerMax.value;
  return measured(check(rule, score < limit, { value: score, limit }), gold);
}

/** Motion (Bible 12.2): strictly above the limit, for a shot the plan says must move. */
function motionRow(meanMotion: number | null): TakeRow {
  const rule = CODE_RULES.motion;
  const gold = "take:motion_present";
  if (meanMotion === null) return missing(rule, gold, "the optical flow was not measured");
  const limit = thresholds.take.motionMin.value;
  return measured(check(rule, meanMotion > limit, { value: meanMotion, limit }), gold);
}

/**
 * The code rows of one take, in a fixed order. A measurement object that does not parse makes every code row missing, so no
 * check runs on a guess. The motion row exists only for a shot the plan says must move.
 */
export function codeRows(shot: CodeShot, measurements: unknown): TakeRow[] {
  const parsed = takeMeasurementsSchema.safeParse(measurements);
  if (!parsed.success) {
    const why = `the measurements do not parse (${issuesOf(parsed.error)})`;
    const rows = [
      missing(CODE_RULES.duration, "take:duration_within_tolerance", why),
      missing(CODE_RULES.blackFrames, "take:no_black_or_frozen_frames", why),
      missing(CODE_RULES.flicker, "take:flicker_below_max", why),
    ];
    if (shot.motionRequired) rows.push(missing(CODE_RULES.motion, "take:motion_present", why));
    return rows;
  }
  const values = parsed.data;
  const rows = [
    durationRow(shot.plannedDurationMs, values.durationMs),
    blackFramesRow(values.blackOrFrozenRunFrames),
    flickerRow(values.flickerScore),
  ];
  if (shot.motionRequired) rows.push(motionRow(values.meanMotion));
  return rows;
}
