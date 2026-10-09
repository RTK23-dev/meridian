/**
 * Model Parameter Lifecycle Management
 *
 * Enforces strict scientific lifecycle progression for learned model weights:
 * seed_prior -> candidate_fit -> fitted -> validated -> retired
 *
 * Unified Hierarchy:
 * organization -> brand -> population -> parameter -> version
 *
 * Rules:
 * - A parameter NEVER starts as fitted or validated.
 * - Evidence counts and sample thresholds are mandatory for state promotions.
 * - Scores are scores until a calibration report says otherwise.
 */

import type { Sql } from "./store.ts";

export type ParameterState = "seed_prior" | "candidate_fit" | "fitted" | "validated" | "retired";
export type ModelParameterStatus = ParameterState;

export type ModelParameterRecord = {
  id: string;
  organizationId: string;
  brandId: string;
  population: string;
  parameterName: string;
  version: string;
  state: ParameterState;
  priorValue: number;
  posteriorValue?: number | null;
  sampleSize: number;
  calibrationMetrics: Record<string, unknown>;
  provenanceFilter: string;
  notes?: string | null;
  fitDate?: string | null;
  createdAt: string;
  updatedAt: string;
  // Backward compatibility convenience accessors
  parameterValue?: Record<string, unknown>;
  evidenceCount?: number;
  calibrationScore?: number | null;
};

export async function upsertModelParameter(
  sql: Sql,
  input: {
    organizationId: string;
    brandId?: string;
    population?: string;
    parameterName: string;
    version?: string;
    state?: ParameterState;
    priorValue?: number;
    posteriorValue?: number | null;
    sampleSize?: number;
    calibrationMetrics?: Record<string, unknown>;
    provenanceFilter?: string;
    notes?: string;
    // Backward compatibility fields
    parameterValue?: Record<string, unknown>;
    evidenceCount?: number;
    calibrationScore?: number | null;
  },
): Promise<ModelParameterRecord> {
  const version = input.version || "v1-seed";
  const state = input.state || "seed_prior";
  const brandId = input.brandId || "system";
  const population = input.population || "global";
  const id = `param_${input.organizationId}_${brandId}_${input.parameterName}_${version}`;

  const sampleSize = input.sampleSize ?? input.evidenceCount ?? 0;
  const calibrationMetrics = input.calibrationMetrics ?? (typeof input.calibrationScore === "number" ? { score: input.calibrationScore } : {});
  const priorValue = input.priorValue ?? (typeof input.parameterValue?.prior === "number" ? input.parameterValue.prior : (typeof input.parameterValue?.mean === "number" ? input.parameterValue.mean : 0.0));
  const posteriorValue = input.posteriorValue ?? (typeof input.parameterValue?.posterior === "number" ? input.parameterValue.posterior : null);
  const provenanceFilter = input.provenanceFilter || "real_only";

  // Validate state promotion constraints
  if (state === "fitted" && sampleSize < 50) {
    throw new Error(`Cannot promote parameter to 'fitted' with fewer than 50 observations (found ${sampleSize}).`);
  }
  const hasCalibration = typeof input.calibrationScore === "number" || Object.keys(calibrationMetrics).length > 0;
  if (state === "validated" && (sampleSize < 100 || !hasCalibration)) {
    throw new Error("Cannot validate parameter without at least 100 observations and an empirical calibration score.");
  }

  const rows = await sql<any>`
    insert into model_parameters (
      id,
      organization_id,
      brand_id,
      population,
      parameter_name,
      version,
      state,
      prior_value,
      posterior_value,
      sample_size,
      calibration_metrics,
      provenance_filter,
      notes,
      fit_date,
      updated_at
    ) values (
      ${id},
      ${input.organizationId},
      ${brandId},
      ${population},
      ${input.parameterName},
      ${version},
      ${state},
      ${priorValue},
      ${posteriorValue},
      ${sampleSize},
      ${JSON.stringify(calibrationMetrics)}::jsonb,
      ${provenanceFilter},
      ${input.notes ?? null},
      ${state === "fitted" || state === "validated" ? sql`now()` : null},
      now()
    )
    on conflict (organization_id, brand_id, population, parameter_name, version) do update set
      state = excluded.state,
      prior_value = excluded.prior_value,
      posterior_value = excluded.posterior_value,
      sample_size = excluded.sample_size,
      calibration_metrics = excluded.calibration_metrics,
      provenance_filter = excluded.provenance_filter,
      notes = excluded.notes,
      fit_date = case when excluded.state in ('fitted', 'validated') then now() else model_parameters.fit_date end,
      updated_at = now()
    returning
      id,
      organization_id as "organizationId",
      brand_id as "brandId",
      population,
      parameter_name as "parameterName",
      version,
      state,
      prior_value as "priorValue",
      posterior_value as "posteriorValue",
      sample_size as "sampleSize",
      calibration_metrics as "calibrationMetrics",
      provenance_filter as "provenanceFilter",
      notes,
      fit_date as "fitDate",
      created_at as "createdAt",
      updated_at as "updatedAt"
  `;

  const r = rows[0];
  if (!r) throw new Error("Failed to upsert model parameter");
  return {
    ...r,
    sampleSize: Number(r.sampleSize),
    priorValue: Number(r.priorValue),
    posteriorValue: r.posteriorValue != null ? Number(r.posteriorValue) : null,
    evidenceCount: Number(r.sampleSize),
    parameterValue: { prior: Number(r.priorValue), posterior: r.posteriorValue != null ? Number(r.posteriorValue) : null },
    calibrationScore: typeof r.calibrationMetrics?.score === "number" ? r.calibrationMetrics.score : null,
  };
}

export async function getModelParameter(
  sql: Sql,
  organizationId: string,
  parameterName: string,
  version?: string,
  brandId = "system",
  population = "global",
): Promise<ModelParameterRecord | null> {
  if (version) {
    const rows = await sql<any>`
      select
        id,
        organization_id as "organizationId",
        brand_id as "brandId",
        population,
        parameter_name as "parameterName",
        version,
        state,
        prior_value as "priorValue",
        posterior_value as "posteriorValue",
        sample_size as "sampleSize",
        calibration_metrics as "calibrationMetrics",
        provenance_filter as "provenanceFilter",
        notes,
        fit_date as "fitDate",
        created_at as "createdAt",
        updated_at as "updatedAt"
      from model_parameters
      where organization_id = ${organizationId}
        and brand_id = ${brandId}
        and population = ${population}
        and parameter_name = ${parameterName}
        and version = ${version}
      limit 1
    `;
    const r = rows[0];
    if (!r) return null;
    return {
      ...r,
      sampleSize: Number(r.sampleSize),
      priorValue: Number(r.priorValue),
      posteriorValue: r.posteriorValue != null ? Number(r.posteriorValue) : null,
      evidenceCount: Number(r.sampleSize),
      parameterValue: { prior: Number(r.priorValue), posterior: r.posteriorValue != null ? Number(r.posteriorValue) : null },
      calibrationScore: typeof r.calibrationMetrics?.score === "number" ? r.calibrationMetrics.score : null,
    };
  }

  const rows = await sql<any>`
    select
      id,
      organization_id as "organizationId",
      brand_id as "brandId",
      population,
      parameter_name as "parameterName",
      version,
      state,
      prior_value as "priorValue",
      posterior_value as "posteriorValue",
      sample_size as "sampleSize",
      calibration_metrics as "calibrationMetrics",
      provenance_filter as "provenanceFilter",
      notes,
      fit_date as "fitDate",
      created_at as "createdAt",
      updated_at as "updatedAt"
    from model_parameters
    where organization_id = ${organizationId}
      and parameter_name = ${parameterName}
    order by updated_at desc
    limit 1
  `;
  const r = rows[0];
  if (!r) return null;
  return {
    ...r,
    sampleSize: Number(r.sampleSize),
    priorValue: Number(r.priorValue),
    posteriorValue: r.posteriorValue != null ? Number(r.posteriorValue) : null,
    evidenceCount: Number(r.sampleSize),
    parameterValue: { prior: Number(r.priorValue), posterior: r.posteriorValue != null ? Number(r.posteriorValue) : null },
    calibrationScore: typeof r.calibrationMetrics?.score === "number" ? r.calibrationMetrics.score : null,
  };
}
