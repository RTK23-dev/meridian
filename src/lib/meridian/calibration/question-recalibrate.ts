/**
 * Recomputes one brand's calibration for the grading questions. Called by the learning.update job (jobs/execute.ts) after the brand's
 * patterns are recomputed, and by the calibration server function. It holds no server-function import, so the worker can load it.
 *
 * Only the questions whose answer is a probability are calibrated. A choice question (the risk question) answers with a category, so
 * there is no probability to calibrate, and it has no report.
 */
import type { Sql } from "../learning/store.ts";
import { GRADING_QUESTIONS } from "../factory/grade.ts";
import { recordQuestionCalibrations, type CalibrationScope, type RecordedCalibration, type QuestionRef } from "./question-store.ts";

/** The grading questions with a probability to calibrate: the questions whose spec is a noul. */
export function calibratableGradingQuestions(): QuestionRef[] {
  return GRADING_QUESTIONS.filter((question) => question.spec.type === "noul").map((question) => ({
    questionId: question.spec.id,
    questionVersion: question.spec.version,
  }));
}

/** Measures and stores the brand's calibration for every calibratable grading question. */
export async function recalibrateGradingQuestions(sql: Sql, scope: CalibrationScope): Promise<RecordedCalibration[]> {
  return recordQuestionCalibrations(sql, scope, calibratableGradingQuestions());
}

/** One line for a job's result: how many questions are calibrated, and how many reports were newly stored. */
export function summarizeRecalibration(results: readonly RecordedCalibration[]): string {
  const calibrated = results.filter((result) => result.calibration.status === "calibrated").length;
  const stored = results.filter((result) => result.stored).length;
  return `calibration:${calibrated} of ${results.length} calibrated, ${stored} stored`;
}

/**
 * The recomputation for a worker job or a learn stage, as one line for its result. A failure is named in that line and is not thrown,
 * so the pattern update the job just made is not failed by a calibration error.
 */
export async function recalibrateForJob(sql: Sql, scope: CalibrationScope): Promise<string> {
  try {
    return summarizeRecalibration(await recalibrateGradingQuestions(sql, scope));
  } catch (error) {
    return `calibration:failed ${error instanceof Error ? error.message : String(error)}`;
  }
}
