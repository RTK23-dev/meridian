/**
 * Storage for the per-brand, per-question calibration of the grading questions (calibration/question-method.ts).
 *
 * Every read and write is scoped to one workspace and one brand. The observations are not stored: they are read from the picks,
 * the grades, the creatives, the measured telemetry and the stored answers, and the report is what is stored. A recomputation
 * that finds the same content as the newest report stores nothing, so the newest report is the one the gate reads.
 *
 * The decision gate reads calibratedThresholdsOf. A read that fails is the caller's to handle: the gate keeps the registry policy.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import {
  calibrateQuestion,
  QUESTION_CALIBRATION_METHOD,
  type QuestionCalibration,
  type ReliabilityBin,
} from "./question-method.ts";
import {
  buildQuestionOutcomes,
  questionKeyOf,
  type OutcomeAnswer,
  type OutcomeBuild,
  type OutcomeCreative,
  type OutcomeInputs,
  type OutcomePick,
  type OutcomeTelemetryRow,
} from "./question-outcomes.ts";
import type { GradeRecord } from "../factory/prediction.ts";
import type { AppliedCalibration } from "../decisions/policy.ts";
import { isoTimestamp } from "../observability/timestamps.ts";

export type CalibrationScope = { organizationId: string; brandId: string };

/** A question version whose calibration is measured. */
export type QuestionRef = { questionId: string; questionVersion: string };

export type MeasuredQuestion = QuestionRef & { calibration: QuestionCalibration };

export type MeasuredCalibrations = {
  questions: Map<string, MeasuredQuestion>;
  baselines: OutcomeBuild["baselines"];
  excluded: OutcomeBuild["excluded"];
};

export type RecordedCalibration = MeasuredQuestion & { reportId: string; stored: boolean };

export type StoredQuestionCalibration = QuestionRef & {
  id: string;
  methodVersion: string;
  status: "calibrated" | "uncalibrated";
  reason: string;
  sampleSize: number;
  /** The approve threshold, present only for a calibrated report. */
  threshold: number | null;
  thresholdsText: string;
  reliabilityText: string;
  reliability: ReliabilityBin[];
  createdAt: string;
};

/** The JSON a report stores as its thresholds. An uncalibrated report stores none. */
export function thresholdsTextOf(calibration: QuestionCalibration): string {
  return JSON.stringify(calibration.threshold === null ? {} : { approveMinProbability: calibration.threshold });
}

function jsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return value ?? null;
}

function arrayOf(value: unknown): unknown[] {
  const parsed = jsonValue(value);
  return Array.isArray(parsed) ? parsed : [];
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function templateIdOf(runId: string, researchAdId: string): string {
  return `tpl:${runId}:${researchAdId}`;
}

function gateAnswersOf(votes: unknown, unresolved: unknown): OutcomePick["gateAnswers"] {
  const items = [...arrayOf(votes), ...arrayOf(unresolved)];
  const answers: OutcomePick["gateAnswers"] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as { questionId?: unknown; runId?: unknown };
    if (typeof record.questionId !== "string") continue;
    answers.push({ runId: typeof record.runId === "string" ? record.runId : null, questionId: record.questionId });
  }
  return answers;
}

/** The observation inputs of one brand. Every query names the workspace and the brand. */
export async function loadQuestionOutcomeInputs(sql: Sql, scope: CalibrationScope): Promise<OutcomeInputs> {
  const pickRows = await sql<{
    pick_id: string;
    run_id: string;
    research_ad_id: string;
    surface: string;
    grade_fingerprint: string;
    jev_status: string | null;
    jev_action: string | null;
    jev_reason: string | null;
    jev_engine_id: string | null;
    jev_model: string | null;
    jev_question_versions: string | null;
    jev_policy_version: string | null;
    jev_gate_record_id: string | null;
    votes: unknown;
    unresolved: unknown;
  }>`
    select p.id as pick_id, p.run_id, p.research_ad_id, p.surface, p.grade_fingerprint,
      ad.jev_status, ad.jev_action, ad.jev_reason, ad.jev_engine_id, ad.jev_model, ad.jev_question_versions,
      ad.jev_policy_version, ad.jev_gate_record_id, g.votes, g.unresolved
    from factory_picks p
    left join ad_timelines ad
      on ad.organization_id = p.organization_id and ad.brand_id = p.brand_id and ad.research_ad_id = p.research_ad_id
    left join decision_gate_records g
      on g.id = ad.jev_gate_record_id and g.organization_id = p.organization_id
    where p.organization_id = ${scope.organizationId} and p.brand_id = ${scope.brandId}
    order by p.id asc
  `;
  const picks: OutcomePick[] = pickRows.map((row) => {
    const grade: GradeRecord = {
      jev_status: row.jev_status,
      jev_action: row.jev_action,
      jev_reason: row.jev_reason ?? "",
      jev_engine_id: row.jev_engine_id,
      jev_model: row.jev_model,
      jev_question_versions: row.jev_question_versions ?? "[]",
      jev_policy_version: row.jev_policy_version ?? "",
      jev_gate_record_id: row.jev_gate_record_id,
    };
    return {
      pickId: row.pick_id,
      surface: row.surface,
      storedFingerprint: row.grade_fingerprint,
      grade,
      gateAnswers: gateAnswersOf(row.votes, row.unresolved),
      templateId: templateIdOf(row.run_id, row.research_ad_id),
    };
  });

  const templateIds = [...new Set(picks.map((pick) => pick.templateId))];
  let creatives: OutcomeCreative[] = [];
  if (templateIds.length > 0) {
    const creativeRows = await sql<{ template_id: string; creative_id: string }>`
      select v.template_id, fc.creative_id
      from factory_creatives fc
      join factory_variants v on v.id = fc.variant_id and v.organization_id = fc.organization_id
      where fc.organization_id = ${scope.organizationId} and fc.brand_id = ${scope.brandId}
        and v.tests_attribute = 'control' and v.template_id = any(${templateIds})
      order by fc.format asc, fc.creative_id asc
    `;
    creatives = creativeRows.map((row) => ({ templateId: row.template_id, creativeId: row.creative_id }));
  }

  // Newest first, so the builder takes the newest measured row of each creative.
  const telemetryRows = await sql<{
    creative_id: string;
    source_type: string;
    clicks: unknown;
    impressions: unknown;
    completion_rate: unknown;
    metadata: unknown;
  }>`
    select creative_id, source_type, clicks, impressions, completion_rate, metadata
    from unified_performance_telemetry
    where organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
      and source_type in ('organic', 'paid') and creative_id <> ''
    order by recorded_at desc, id desc
  `;
  const telemetry: OutcomeTelemetryRow[] = telemetryRows.map((row) => ({
    creativeId: row.creative_id,
    surface: row.source_type,
    clicks: numberOrNull(row.clicks),
    impressions: numberOrNull(row.impressions),
    completionRate: numberOrNull(row.completion_rate),
    metadata: row.metadata,
  }));

  const runIds = [...new Set(picks.flatMap((pick) => pick.gateAnswers.flatMap((answer) => (answer.runId ? [answer.runId] : []))))];
  let answers: OutcomeAnswer[] = [];
  if (runIds.length > 0) {
    const answerRows = await sql<{
      run_id: string;
      question_id: string;
      question_version: string;
      probability: unknown;
      status: string;
    }>`
      select run_id, question_id, question_version, probability, status
      from jev_answers
      where organization_id = ${scope.organizationId} and brand_id = ${scope.brandId} and run_id = any(${runIds})
    `;
    answers = answerRows.map((row) => ({
      runId: row.run_id,
      questionId: row.question_id,
      questionVersion: row.question_version,
      probability: numberOrNull(row.probability),
      status: row.status,
    }));
  }

  return { picks, creatives, telemetry, answers };
}

/** The calibration of each question version, measured now from the brand's outcomes. Nothing is stored. */
export async function measureQuestionCalibrations(
  sql: Sql,
  scope: CalibrationScope,
  questions: readonly QuestionRef[],
): Promise<MeasuredCalibrations> {
  const build = buildQuestionOutcomes(await loadQuestionOutcomeInputs(sql, scope));
  const measured = new Map<string, MeasuredQuestion>();
  for (const question of questions) {
    const key = questionKeyOf(question.questionId, question.questionVersion);
    measured.set(key, {
      questionId: question.questionId,
      questionVersion: question.questionVersion,
      calibration: calibrateQuestion(build.questions.get(key)?.observations ?? []),
    });
  }
  return { questions: measured, baselines: build.baselines, excluded: build.excluded };
}

/** The newest stored report of each question version, or none. Scoped to the brand. */
export async function latestQuestionCalibrations(
  sql: Sql,
  scope: CalibrationScope,
  questions: readonly QuestionRef[],
): Promise<Map<string, StoredQuestionCalibration>> {
  const out = new Map<string, StoredQuestionCalibration>();
  if (questions.length === 0) return out;
  const questionIds = [...new Set(questions.map((question) => question.questionId))];
  const rows = await sql<{
    id: string;
    question_id: string;
    question_version: string;
    method_version: string;
    status: string;
    reason: string;
    sample_size: number | string;
    thresholds: string;
    reliability: string;
    created_at: unknown;
  }>`
    select distinct on (question_id, question_version)
      id, question_id, question_version, method_version, status, reason, sample_size, thresholds, reliability, created_at
    from question_calibration_reports
    where organization_id = ${scope.organizationId} and brand_id = ${scope.brandId} and question_id = any(${questionIds})
    order by question_id, question_version, created_at desc, id desc
  `;
  const wanted = new Set(questions.map((question) => questionKeyOf(question.questionId, question.questionVersion)));
  for (const row of rows) {
    const key = questionKeyOf(row.question_id, row.question_version);
    if (!wanted.has(key)) continue;
    const thresholds = jsonValue(row.thresholds);
    const approve = thresholds && typeof thresholds === "object" ? (thresholds as { approveMinProbability?: unknown }).approveMinProbability : undefined;
    out.set(key, {
      id: row.id,
      questionId: row.question_id,
      questionVersion: row.question_version,
      methodVersion: row.method_version,
      status: row.status === "calibrated" ? "calibrated" : "uncalibrated",
      reason: row.reason,
      sampleSize: Number(row.sample_size),
      threshold: typeof approve === "number" && Number.isFinite(approve) ? approve : null,
      thresholdsText: row.thresholds,
      reliabilityText: row.reliability,
      reliability: arrayOf(row.reliability) as ReliabilityBin[],
      createdAt: isoTimestamp(row.created_at),
    });
  }
  return out;
}

/**
 * Measures each question version and stores its report, unless the newest stored report already has the same content. The
 * observations, the counts and the thresholds are all part of the content, so the same data stores nothing new.
 */
export async function recordQuestionCalibrations(
  sql: Sql,
  scope: CalibrationScope,
  questions: readonly QuestionRef[],
): Promise<RecordedCalibration[]> {
  const measured = await measureQuestionCalibrations(sql, scope, questions);
  const latest = await latestQuestionCalibrations(sql, scope, questions);
  const recorded: RecordedCalibration[] = [];
  for (const question of questions) {
    const key = questionKeyOf(question.questionId, question.questionVersion);
    const entry = measured.questions.get(key)!;
    const calibration = entry.calibration;
    const thresholdsText = thresholdsTextOf(calibration);
    const reliabilityText = JSON.stringify(calibration.reliability);
    const prior = latest.get(key);
    if (
      prior &&
      prior.methodVersion === calibration.method &&
      prior.status === calibration.status &&
      prior.reason === calibration.reason &&
      prior.sampleSize === calibration.sampleSize &&
      prior.thresholdsText === thresholdsText &&
      prior.reliabilityText === reliabilityText
    ) {
      recorded.push({ ...entry, reportId: prior.id, stored: false });
      continue;
    }
    const id = `qcal-${randomUUID()}`;
    await sql`
      insert into question_calibration_reports (
        id, organization_id, brand_id, question_id, question_version, method_version, status, reason, sample_size, thresholds, reliability
      ) values (
        ${id}, ${scope.organizationId}, ${scope.brandId}, ${question.questionId}, ${question.questionVersion},
        ${calibration.method}, ${calibration.status}, ${calibration.reason}, ${calibration.sampleSize}, ${thresholdsText}, ${reliabilityText}
      )
    `;
    recorded.push({ ...entry, reportId: id, stored: true });
  }
  return recorded;
}

/**
 * The calibrated thresholds the gate applies: for each question version whose newest report is calibrated under the current method.
 * A question with no report, or whose newest report is uncalibrated, has no entry, and keeps its registry policy.
 */
export async function calibratedThresholdsOf(
  sql: Sql,
  scope: CalibrationScope,
  questions: readonly QuestionRef[],
): Promise<Map<string, AppliedCalibration>> {
  const latest = await latestQuestionCalibrations(sql, scope, questions);
  const applied = new Map<string, AppliedCalibration>();
  for (const [key, report] of latest) {
    if (report.status !== "calibrated" || report.methodVersion !== QUESTION_CALIBRATION_METHOD) continue;
    if (report.threshold === null || report.threshold < 0 || report.threshold > 1) continue;
    applied.set(key, { reportId: report.id, sampleSize: report.sampleSize, threshold: report.threshold });
  }
  return applied;
}
