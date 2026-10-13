/**
 * Observations for the calibration of a brand's grading questions (NORTH_STAR section 9, question 3).
 *
 * One observation is one pick, for one grading question: the probability the engine stated for that question when the pick's ad was
 * graded, and whether the pick's creative met the success definition. Only real measured rows count. Pure: the caller loads the rows
 * (question-store.ts), so this file is testable without a database.
 *
 * Rules, each enforced here:
 * - A pick counts only when its stored grade fingerprint is the ad's grade now (predictionStatusOf "same"). A pick whose ad was graded
 *   again has a prediction nobody can recover, so it is not an observation. A pick written before the fingerprint has none.
 * - The creative is the pick's control variant (its first creative, in format order). The variants test one attribute each, so their
 *   outcomes do not measure the grade.
 * - The outcome is the newest measured row of that creative on the pick's surface that reports the surface's metric. A metric the
 *   source did not report is null, and a row without it is skipped, so an unreported metric is never counted.
 * - A row marked synthetic or simulated in its metadata is never an outcome, and never sets a baseline.
 *
 * The success definition is the same for every question, because no question in the registry defines one. A creative succeeds when
 * its metric is above the median of the brand's measured creatives on the same surface. Paid uses click-through rate (clicks divided
 * by impressions, both reported, impressions above zero). Organic uses completion rate. A surface with fewer than
 * SURFACE_BASELINE_MINIMUM_CREATIVES measured creatives has no baseline, so its picks are not observations.
 */
import { predictionStatusOf, type GradeRecord } from "../factory/prediction.ts";
import type { CalibrationObservation } from "./question-method.ts";

/** Measured creatives a surface needs before its median is a baseline. */
export const SURFACE_BASELINE_MINIMUM_CREATIVES = 2;

export type OutcomeSurface = "paid" | "organic";

export type OutcomePick = {
  pickId: string;
  /** The stored surface: `organic`, `paid`, or `''` for a pick written before migration 0071. */
  surface: string;
  storedFingerprint: string;
  /** The ad's grade as it stands now, or null when the ad has no grade row. */
  grade: GradeRecord | null;
  /** Which engine run answered each question of the pick's gate. A question with no run was refused locally. */
  gateAnswers: Array<{ runId: string | null; questionId: string }>;
  /** The factory template of the pick: `tpl:<run id>:<research ad id>`. */
  templateId: string;
};

/** A creative of a control variant. Rows are ordered by format, then creative id, so the first row of a template is its creative. */
export type OutcomeCreative = { templateId: string; creativeId: string };

/** A telemetry row. The caller orders the rows newest first. */
export type OutcomeTelemetryRow = {
  creativeId: string;
  /** The row's source type: `organic`, `paid`, or `hybrid`. Only the first two are outcomes. */
  surface: string;
  clicks: number | null;
  impressions: number | null;
  completionRate: number | null;
  metadata: unknown;
};

/** One stored answer of a decision run, for one question. */
export type OutcomeAnswer = {
  runId: string;
  questionId: string;
  questionVersion: string;
  probability: number | null;
  status: string;
};

export type OutcomeInputs = {
  picks: OutcomePick[];
  creatives: OutcomeCreative[];
  telemetry: OutcomeTelemetryRow[];
  answers: OutcomeAnswer[];
};

export type QuestionObservations = {
  questionId: string;
  questionVersion: string;
  observations: CalibrationObservation[];
};

export type OutcomeBuild = {
  /** Observations keyed by `questionKeyOf(questionId, questionVersion)`, each list sorted by pick id. */
  questions: Map<string, QuestionObservations>;
  /** The median of the brand's measured creatives on each surface, or null when the surface has too few. */
  baselines: Record<OutcomeSurface, number | null>;
  /** Picks that were not observations, counted by the reason they were not. */
  excluded: Record<string, number>;
};

export function questionKeyOf(questionId: string, questionVersion: string): string {
  return `${questionId}@${questionVersion}`;
}

/** Whether a telemetry row's metadata marks it synthetic or simulated. Such a row is never read as a measurement. */
export function isSimulated(metadata: unknown): boolean {
  let record: unknown = metadata;
  if (typeof metadata === "string") {
    try {
      record = JSON.parse(metadata) as unknown;
    } catch {
      return false;
    }
  }
  if (!record || typeof record !== "object") return false;
  const flags = record as { synthetic?: unknown; simulated?: unknown };
  return flags.synthetic === true || flags.simulated === true;
}

/** The surface's metric for one row, or null when the row did not report it. */
export function outcomeValueOf(row: OutcomeTelemetryRow, surface: OutcomeSurface): number | null {
  if (surface === "paid") {
    if (row.clicks === null || row.impressions === null || row.impressions <= 0) return null;
    return row.clicks / row.impressions;
  }
  if (row.completionRate === null || !Number.isFinite(row.completionRate)) return null;
  return row.completionRate;
}

/** The median of a list of numbers, or null for an empty list. */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function isProbability(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isOutcomeSurface(value: string): value is OutcomeSurface {
  return value === "paid" || value === "organic";
}

export function buildQuestionOutcomes(input: OutcomeInputs): OutcomeBuild {
  // The newest measured value per creative and surface. Rows arrive newest first, so the first row that reports the metric wins.
  const measured = new Map<string, { surface: OutcomeSurface; value: number }>();
  for (const row of input.telemetry) {
    if (!isOutcomeSurface(row.surface) || isSimulated(row.metadata)) continue;
    const key = `${row.surface}|${row.creativeId}`;
    if (measured.has(key)) continue;
    const value = outcomeValueOf(row, row.surface);
    if (value !== null) measured.set(key, { surface: row.surface, value });
  }

  const baselines: Record<OutcomeSurface, number | null> = { paid: null, organic: null };
  for (const surface of ["paid", "organic"] as const) {
    const values = [...measured.values()].filter((entry) => entry.surface === surface).map((entry) => entry.value);
    baselines[surface] = values.length >= SURFACE_BASELINE_MINIMUM_CREATIVES ? medianOf(values) : null;
  }

  const creativeOfTemplate = new Map<string, string>();
  for (const creative of input.creatives) {
    if (!creativeOfTemplate.has(creative.templateId)) creativeOfTemplate.set(creative.templateId, creative.creativeId);
  }

  const answerOf = new Map<string, OutcomeAnswer>();
  for (const answer of input.answers) answerOf.set(`${answer.runId}|${answer.questionId}`, answer);

  const excluded: Record<string, number> = {};
  const exclude = (reason: string) => {
    excluded[reason] = (excluded[reason] ?? 0) + 1;
  };
  const questions = new Map<string, { questionId: string; questionVersion: string; items: Array<{ pickId: string; observation: CalibrationObservation }> }>();

  const picks = [...input.picks].sort((a, b) => (a.pickId < b.pickId ? -1 : a.pickId > b.pickId ? 1 : 0));
  for (const pick of picks) {
    if (!isOutcomeSurface(pick.surface)) {
      exclude("no_surface");
      continue;
    }
    const status = predictionStatusOf(pick.storedFingerprint, pick.grade);
    if (status !== "same") {
      exclude(status === "unrecorded" ? "unrecorded_grade" : "regraded");
      continue;
    }
    const creativeId = creativeOfTemplate.get(pick.templateId);
    if (creativeId === undefined) {
      exclude("no_creative");
      continue;
    }
    const outcome = measured.get(`${pick.surface}|${creativeId}`);
    if (!outcome) {
      exclude("no_outcome");
      continue;
    }
    const baseline = baselines[pick.surface];
    if (baseline === null) {
      exclude("no_baseline");
      continue;
    }
    const success = outcome.value > baseline;

    const seen = new Set<string>();
    for (const gateAnswer of pick.gateAnswers) {
      if (!gateAnswer.runId || seen.has(gateAnswer.questionId)) continue;
      seen.add(gateAnswer.questionId);
      const answer = answerOf.get(`${gateAnswer.runId}|${gateAnswer.questionId}`);
      if (!answer || answer.status !== "answered" || !isProbability(answer.probability)) continue;
      const key = questionKeyOf(answer.questionId, answer.questionVersion);
      let entry = questions.get(key);
      if (!entry) {
        entry = { questionId: answer.questionId, questionVersion: answer.questionVersion, items: [] };
        questions.set(key, entry);
      }
      entry.items.push({ pickId: pick.pickId, observation: { predicted: answer.probability, success } });
    }
  }

  // Picks are visited in pick id order, so each list is in pick id order too.
  const result = new Map<string, QuestionObservations>();
  for (const [key, entry] of questions) {
    result.set(key, {
      questionId: entry.questionId,
      questionVersion: entry.questionVersion,
      observations: entry.items.map((item) => item.observation),
    });
  }
  return { questions: result, baselines, excluded };
}
