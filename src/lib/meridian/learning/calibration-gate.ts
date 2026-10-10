/**
 * The calibration gate (P5c).
 *
 * A learned parameter may be promoted to fitted or validated, and may then influence JEV or ranking, only with a stored
 * calibration report for its decision class. The report must show a change that improves prediction on held-out outcomes,
 * over at least HELD_OUT_MINIMUM of them. Without that, the seed prior is the value in use, and any learned value is shown
 * as LEARNED with its sample size, never as the decision's basis.
 *
 * HELD_OUT_MINIMUM is the threshold the roadmap lists as an open question (200 per decision class). It is a default until
 * an owner decides otherwise, and it is stated here so it can be changed in one place.
 */
import type { Sql } from "./store.ts";

export const HELD_OUT_MINIMUM = 200;

export interface CalibrationReport {
  decisionClass: string;
  heldOutCount: number;
  /** Brier score on held-out outcomes before the change. Lower is better. */
  brierBefore: number;
  /** Brier score on the same held-out outcomes after the change. */
  brierAfter: number;
}

export type LearnedUse = { usable: true } | { usable: false; reason: string };

/** Whether a learned value may influence a decision, given the latest report for its class. */
export function learnedWeightUsable(report: CalibrationReport | null): LearnedUse {
  if (!report) return { usable: false, reason: "no calibration report exists for this decision class" };
  if (!Number.isFinite(report.heldOutCount) || report.heldOutCount < HELD_OUT_MINIMUM) {
    return { usable: false, reason: `the report has ${report.heldOutCount} held-out outcomes; ${HELD_OUT_MINIMUM} are required` };
  }
  if (!Number.isFinite(report.brierBefore) || !Number.isFinite(report.brierAfter)) {
    return { usable: false, reason: "the report's scores are not finite numbers" };
  }
  if (report.brierAfter >= report.brierBefore) {
    return { usable: false, reason: "the change does not improve prediction on held-out outcomes" };
  }
  return { usable: true };
}

export interface CalibrationRef {
  organizationId: string;
  brandId: string;
  decisionClass: string;
}

/** The most recent stored report for this decision class in this brand, or null when none exists. */
export async function latestCalibrationReport(sql: Sql, ref: CalibrationRef): Promise<CalibrationReport | null> {
  const rows = await sql<{ decision_class: string; held_out_count: number; brier_before: number; brier_after: number }>`
    select decision_class, held_out_count, brier_before, brier_after from calibration_reports
    where organization_id = ${ref.organizationId} and brand_id = ${ref.brandId} and decision_class = ${ref.decisionClass}
    order by created_at desc, id desc
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    decisionClass: row.decision_class,
    heldOutCount: Number(row.held_out_count),
    brierBefore: Number(row.brier_before),
    brierAfter: Number(row.brier_after),
  };
}

/** Stores a report. Reports are appended, never edited, so the record of what was measured is kept. */
export async function recordCalibrationReport(sql: Sql, ref: CalibrationRef, report: CalibrationReport): Promise<string> {
  const id = `calib-${ref.organizationId}-${ref.brandId}-${report.decisionClass}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await sql`
    insert into calibration_reports (id, organization_id, brand_id, decision_class, held_out_count, brier_before, brier_after)
    values (${id}, ${ref.organizationId}, ${ref.brandId}, ${report.decisionClass}, ${report.heldOutCount}, ${report.brierBefore}, ${report.brierAfter})
  `;
  return id;
}

export interface ResolvedParameter {
  value: number;
  /** `seed_prior` unless the learned value is usable under the gate, in which case it is `LEARNED`. */
  source: "seed_prior" | "LEARNED";
  sampleSize: number;
  /** Why the learned value is not in use, when it is not. Null when it is. */
  reason: string | null;
}

/**
 * The value a decision should use for one parameter. A learned posterior is used only when its parameter is fitted or
 * validated and the latest calibration report for its class passes the gate. Otherwise the seed prior is used, and the
 * reason is returned so a reader can see why the learned value is absent.
 */
export async function resolveParameterForUse(
  sql: Sql,
  ref: { organizationId: string; brandId: string; parameterName: string },
): Promise<ResolvedParameter | null> {
  const rows = await sql<{ state: string; prior_value: number; posterior_value: number | null; sample_size: number }>`
    select state, prior_value, posterior_value, sample_size from model_parameters
    where organization_id = ${ref.organizationId} and brand_id = ${ref.brandId} and parameter_name = ${ref.parameterName}
    order by updated_at desc, id desc
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;

  const sampleSize = Number(row.sample_size);
  const promoted = row.state === "fitted" || row.state === "validated";
  if (!promoted || row.posterior_value === null) {
    return { value: Number(row.prior_value), source: "seed_prior", sampleSize, reason: promoted ? "no learned value is recorded" : `the parameter is ${row.state}` };
  }
  const gate = learnedWeightUsable(await latestCalibrationReport(sql, { organizationId: ref.organizationId, brandId: ref.brandId, decisionClass: ref.parameterName }));
  if (!gate.usable) {
    return { value: Number(row.prior_value), source: "seed_prior", sampleSize, reason: gate.reason };
  }
  return { value: Number(row.posterior_value), source: "LEARNED", sampleSize, reason: null };
}
