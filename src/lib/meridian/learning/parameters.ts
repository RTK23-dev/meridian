/**
 * Model Parameter Lifecycle Management
 *
 * Enforces strict scientific lifecycle progression for learned model weights:
 * seed_prior -> candidate_fit -> fitted -> validated
 *
 * Rules:
 * - A parameter NEVER starts as fitted or validated.
 * - Evidence counts and sample thresholds are mandatory for state promotions.
 * - Scores are scores until a calibration report says otherwise.
 */

import type { Sql } from "./store.ts";

export type ParameterState = "seed_prior" | "candidate_fit" | "fitted" | "validated";

export type ModelParameterRecord = {
  id: string;
  organizationId: string;
  parameterName: string;
  version: string;
  state: ParameterState;
  parameterValue: Record<string, unknown>;
  evidenceCount: number;
  calibrationScore?: number | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function upsertModelParameter(
  sql: Sql,
  input: {
    organizationId: string;
    parameterName: string;
    version?: string;
    state?: ParameterState;
    parameterValue: Record<string, unknown>;
    evidenceCount?: number;
    calibrationScore?: number;
    notes?: string;
  },
): Promise<ModelParameterRecord> {
  const version = input.version || "v1-seed";
  const state = input.state || "seed_prior";
  const id = `param_${input.parameterName}_${version}`;

  // Validate state promotion constraints
  const evidenceCount = input.evidenceCount ?? 0;
  if (state === "fitted" && evidenceCount < 50) {
    throw new Error(`Cannot promote parameter to 'fitted' with fewer than 50 observations (found ${evidenceCount}).`);
  }
  if (state === "validated" && (evidenceCount < 100 || typeof input.calibrationScore !== "number")) {
    throw new Error("Cannot validate parameter without at least 100 observations and an empirical calibration score.");
  }

  const rows = await sql<ModelParameterRecord>`
    insert into model_parameters (
      id,
      organization_id,
      parameter_name,
      version,
      state,
      parameter_value,
      evidence_count,
      calibration_score,
      notes,
      updated_at
    ) values (
      ${id},
      ${input.organizationId},
      ${input.parameterName},
      ${version},
      ${state},
      ${JSON.stringify(input.parameterValue)}::jsonb,
      ${evidenceCount},
      ${input.calibrationScore ?? null},
      ${input.notes ?? null},
      now()
    )
    on conflict (organization_id, parameter_name, version) do update set
      state = excluded.state,
      parameter_value = excluded.parameter_value,
      evidence_count = excluded.evidence_count,
      calibration_score = excluded.calibration_score,
      notes = excluded.notes,
      updated_at = now()
    returning
      id,
      organization_id as "organizationId",
      parameter_name as "parameterName",
      version,
      state,
      parameter_value as "parameterValue",
      evidence_count as "evidenceCount",
      calibration_score as "calibrationScore",
      notes,
      created_at as "createdAt",
      updated_at as "updatedAt"
  `;

  const result = rows[0];
  if (!result) throw new Error("Failed to upsert model parameter");
  return result;
}

export async function getModelParameter(
  sql: Sql,
  organizationId: string,
  parameterName: string,
  version?: string,
): Promise<ModelParameterRecord | null> {
  if (version) {
    const rows = await sql<ModelParameterRecord>`
      select
        id,
        organization_id as "organizationId",
        parameter_name as "parameterName",
        version,
        state,
        parameter_value as "parameterValue",
        evidence_count as "evidenceCount",
        calibration_score as "calibrationScore",
        notes,
        created_at as "createdAt",
        updated_at as "updatedAt"
      from model_parameters
      where organization_id = ${organizationId} and parameter_name = ${parameterName} and version = ${version}
      limit 1
    `;
    return rows[0] ?? null;
  }

  const rows = await sql<ModelParameterRecord>`
    select
      id,
      organization_id as "organizationId",
      parameter_name as "parameterName",
      version,
      state,
      parameter_value as "parameterValue",
      evidence_count as "evidenceCount",
      calibration_score as "calibrationScore",
      notes,
      created_at as "createdAt",
      updated_at as "updatedAt"
    from model_parameters
    where organization_id = ${organizationId} and parameter_name = ${parameterName}
    order by updated_at desc
    limit 1
  `;
  return rows[0] ?? null;
}
