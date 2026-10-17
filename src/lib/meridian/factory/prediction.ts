/**
 * The JEV prediction a pick was made under (NORTH_STAR section 8, items 10 and 11).
 *
 * The grade of an ad is stored on ad_timelines, next to its observed signal, with the engine, model, question versions and action it
 * was given (migration 0067). A pick does not copy that grade. It stores a fingerprint of the grade its ad carried when the pick was
 * made. Later, the run view compares the fingerprint with the ad's grade now: when they match, the grade shown is the prediction the
 * pick was made under, and a measured outcome can be shown beside it; when they differ, the ad was graded again, and the view says so.
 *
 * Pure: no database and no provider. The fingerprint is a hash of what the engine answered, so equal grades give equal fingerprints.
 */

import { createHash } from "node:crypto";

/** The grade columns of ad_timelines a pick reads. A null status means the ad was never graded. */
export type GradeRecord = {
  jev_status: string | null;
  jev_action: string | null;
  jev_reason: string;
  jev_engine_id: string | null;
  jev_model: string | null;
  jev_question_versions: string;
  jev_policy_version: string;
  jev_gate_record_id: string | null;
};

/** The fingerprint of an ad that was never graded. */
export const NOT_GRADED = "not-graded";

/** The fingerprint of an ad graded on its observed signal only, because no decision engine was ready. */
export const OBSERVED_ONLY = "observed-only";

/** The fingerprint of a grade: the engine, its model, the questions and policy it was asked under, and its answer. */
export function predictionFingerprint(grade: GradeRecord | null): string {
  if (!grade || grade.jev_status == null) return NOT_GRADED;
  if (grade.jev_status === "observed_only") return OBSERVED_ONLY;
  if (grade.jev_status !== "engine") return NOT_GRADED;
  const identity = JSON.stringify([
    grade.jev_engine_id,
    grade.jev_model,
    grade.jev_question_versions,
    grade.jev_policy_version,
    grade.jev_action,
    grade.jev_gate_record_id,
  ]);
  return `engine:${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

/** A grade in plain words, for the run view. A missing engine is "not graded", never a score. */
export type PredictionView =
  | { state: "engine"; action: string; engineId: string; model: string; questionVersions: string[]; reason: string }
  | { state: "observed_only"; reason: string }
  | { state: "not_graded" };

function questionVersionsOf(stored: string): string[] {
  try {
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function predictionOf(grade: GradeRecord | null): PredictionView {
  if (!grade || grade.jev_status == null) return { state: "not_graded" };
  if (grade.jev_status === "observed_only") return { state: "observed_only", reason: grade.jev_reason };
  if (grade.jev_status !== "engine" || grade.jev_action == null) return { state: "not_graded" };
  return {
    state: "engine",
    action: grade.jev_action,
    engineId: grade.jev_engine_id ?? "",
    model: grade.jev_model ?? "",
    questionVersions: questionVersionsOf(grade.jev_question_versions),
    reason: grade.jev_reason,
  };
}

/**
 * Whether the grade a pick stored is still the ad's grade:
 * - `unrecorded`: the pick was written before fingerprints were stored, so the prediction it was made under is not known;
 * - `same`: the ad carries the grade the pick was made under;
 * - `regraded`: the ad was graded again after the pick. The earlier grade is kept in ad_timeline_grades. The grade shown is the current one.
 */
export type PredictionStatus = "unrecorded" | "same" | "regraded";

export function predictionStatusOf(storedFingerprint: string, grade: GradeRecord | null): PredictionStatus {
  if (!storedFingerprint) return "unrecorded";
  return storedFingerprint === predictionFingerprint(grade) ? "same" : "regraded";
}
