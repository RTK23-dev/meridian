/**
 * The per-question calibration of a brand's grading questions, for the calibration screen (calibration/question-method.ts).
 *
 * The read is scoped to the caller's workspace and the brand, and it reports the count measured now and the newest stored report.
 * The recompute is the one mutation: it needs the admin role, and it writes an audit row. Nothing here changes a threshold by itself:
 * the gate reads the newest calibrated report when it decides a new grade.
 */
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertRole, isRole } from "@/lib/meridian/access";
import { GRADING_QUESTIONS } from "@/lib/meridian/factory/grade";
import { calibrationRaisesBar, policyForQuestion } from "@/lib/meridian/decisions/policy";
import { CALIBRATION_MINIMUM_OBSERVATIONS, QUESTION_CALIBRATION_METHOD, type ReliabilityBin } from "./question-method.ts";
import { latestQuestionCalibrations, measureQuestionCalibrations, type CalibrationScope } from "./question-store.ts";
import { calibratableGradingQuestions, recalibrateGradingQuestions } from "./question-recalibrate.ts";

/** The label the screen shows for each grading question. The server names them, so the client holds no question list. */
const QUESTION_LABELS: Record<string, string> = {
  "market.competitive_strength.v1": "Competitive strength",
  "production.reproducibility.v1": "Reproducibility",
  "creative.brand_fit.v1": "Brand fit",
  "brand.positioning_fit.v1": "Positioning fit",
  "safety.policy_risk_level.v1": "Risk and safety",
};

async function brandRole(userId: string, brandId: string) {
  const sql = await getSql();
  const rows = await sql<{ organization_id: string; role: string }>`
    select b.organization_id, m.role
    from brands b
    join memberships m on m.organization_id = b.organization_id and m.user_id = ${userId}
    where b.id = ${brandId} and b.deleted_at is null
    limit 1
  `;
  const row = rows[0];
  if (!row || !isRole(row.role)) throw new Error("That brand is not available to you.");
  return { sql, organizationId: row.organization_id, role: row.role };
}

export type QuestionCalibrationView = {
  questionId: string;
  questionVersion: string;
  label: string;
  /** False for a question whose answer is a category: it has no probability, so it has no calibration. */
  calibratable: boolean;
  /** Observations counted from the brand's outcomes now. Zero for a question that cannot be calibrated. */
  measured: number;
  /** The registry's approve threshold for the question: the bar a calibrated threshold may only raise. Null when it has none. */
  registryThreshold: number | null;
  /** The newest stored report, or null when none has been stored yet. */
  latest: {
    id: string;
    status: "calibrated" | "uncalibrated";
    reason: string;
    sampleSize: number;
    threshold: number | null;
    /** Whether the gate applies this threshold. A calibrated value below the registry's threshold is not applied. */
    applied: boolean;
    reliability: ReliabilityBin[];
    methodVersion: string;
    createdAt: string;
  } | null;
};

export type QuestionCalibrationResult = {
  methodVersion: string;
  minimumSample: number;
  questions: QuestionCalibrationView[];
};

export const getQuestionCalibration = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const brandId = input && typeof input === "object" && typeof (input as { brandId?: unknown }).brandId === "string" ? (input as { brandId: string }).brandId : "";
    if (!brandId) throw new Error("Choose a brand.");
    return { brandId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }): Promise<QuestionCalibrationResult> => {
    const { sql, organizationId } = await brandRole(context.userId, data.brandId);
    const scope: CalibrationScope = { organizationId, brandId: data.brandId };
    const calibratable = calibratableGradingQuestions();
    const measured = await measureQuestionCalibrations(sql, scope, calibratable);
    const latest = await latestQuestionCalibrations(sql, scope, calibratable);
    const questions: QuestionCalibrationView[] = GRADING_QUESTIONS.map((question) => {
      const questionId = question.spec.id;
      const questionVersion = question.spec.version;
      const key = `${questionId}@${questionVersion}`;
      const isCalibratable = question.spec.type === "noul";
      const stored = isCalibratable ? latest.get(key) : undefined;
      const registry = policyForQuestion(question.spec);
      const threshold = stored?.status === "calibrated" ? stored.threshold : null;
      return {
        questionId,
        questionVersion,
        label: QUESTION_LABELS[questionId] ?? questionId,
        calibratable: isCalibratable,
        measured: isCalibratable ? (measured.questions.get(key)?.calibration.sampleSize ?? 0) : 0,
        registryThreshold: registry?.approveMinProbability ?? null,
        latest: stored
          ? {
              id: stored.id,
              status: stored.status,
              reason: stored.reason,
              sampleSize: stored.sampleSize,
              threshold,
              applied: registry !== null && threshold !== null && calibrationRaisesBar(registry, threshold),
              reliability: stored.reliability,
              methodVersion: stored.methodVersion,
              createdAt: stored.createdAt,
            }
          : null,
      };
    });
    return { methodVersion: QUESTION_CALIBRATION_METHOD, minimumSample: CALIBRATION_MINIMUM_OBSERVATIONS, questions };
  });

export type QuestionRecalibrationResult = {
  results: Array<{ questionId: string; label: string; status: "calibrated" | "uncalibrated"; sampleSize: number; reportId: string; stored: boolean }>;
};

export const recomputeQuestionCalibration = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const brandId = input && typeof input === "object" && typeof (input as { brandId?: unknown }).brandId === "string" ? (input as { brandId: string }).brandId : "";
    if (!brandId) throw new Error("Choose a brand.");
    return { brandId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }): Promise<QuestionRecalibrationResult> => {
    const { sql, organizationId, role } = await brandRole(context.userId, data.brandId);
    assertRole(role, "admin");
    const recorded = await recalibrateGradingQuestions(sql, { organizationId, brandId: data.brandId });
    const results = recorded.map((entry) => ({
      questionId: entry.questionId,
      label: QUESTION_LABELS[entry.questionId] ?? entry.questionId,
      status: entry.calibration.status,
      sampleSize: entry.calibration.sampleSize,
      reportId: entry.reportId,
      stored: entry.stored,
    }));
    await sql`
      insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
      values (${crypto.randomUUID()}, ${organizationId}, ${data.brandId}, ${context.userId}, 'calibration.questions_recomputed', 'brand', ${data.brandId}, ${JSON.stringify({ questions: results.length, stored: results.filter((result) => result.stored).length })})
    `;
    return { results };
  });
