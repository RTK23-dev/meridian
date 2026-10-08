/**
 * Opportunity Hypothesis Synthesis
 *
 * Bridges Universal Source Fabric evidence and 11D Angle Bible combinations
 * into actionable OpportunityHypothesis records ready for JEV Gate evaluation.
 */

import type { Sql } from "../learning/store.ts";
import type { PatternCombination } from "./combinations.ts";

export type OpportunityHypothesisRecord = {
  id: string;
  organizationId: string;
  brandId: string;
  hypothesisTitle: string;
  angle: string;
  format: string;
  evidenceBundleId?: string | null;
  patternCombinationId?: string | null;
  targetAudience?: string | null;
  hookDirection?: string | null;
  rationale?: string | null;
  status: "draft" | "approved" | "rejected" | "in_production";
  jevRunId?: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function createOpportunityHypothesis(
  sql: Sql,
  input: {
    organizationId: string;
    brandId: string;
    hypothesisTitle: string;
    angle: string;
    format: string;
    evidenceBundleId?: string;
    patternCombination?: PatternCombination;
    targetAudience?: string;
    hookDirection?: string;
    rationale?: string;
  },
): Promise<OpportunityHypothesisRecord> {
  const id = `opp_${globalThis.crypto.randomUUID()}`;
  const rows = await sql<OpportunityHypothesisRecord>`
    insert into opportunity_hypotheses (
      id,
      organization_id,
      brand_id,
      hypothesis_title,
      angle,
      format,
      evidence_bundle_id,
      pattern_combination_id,
      target_audience,
      hook_direction,
      rationale,
      status,
      created_at,
      updated_at
    ) values (
      ${id},
      ${input.organizationId},
      ${input.brandId},
      ${input.hypothesisTitle},
      ${input.angle},
      ${input.format},
      ${input.evidenceBundleId ?? null},
      ${input.patternCombination?.combinationHash ?? null},
      ${input.targetAudience ?? null},
      ${input.hookDirection ?? null},
      ${input.rationale ?? null},
      'draft',
      now(),
      now()
    )
    returning
      id,
      organization_id as "organizationId",
      brand_id as "brandId",
      hypothesis_title as "hypothesisTitle",
      angle,
      format,
      evidence_bundle_id as "evidenceBundleId",
      pattern_combination_id as "patternCombinationId",
      target_audience as "targetAudience",
      hook_direction as "hookDirection",
      rationale,
      status,
      jev_run_id as "jevRunId",
      created_at as "createdAt",
      updated_at as "updatedAt"
  `;

  const record = rows[0];
  if (!record) throw new Error("Failed to create opportunity hypothesis");
  return record;
}

export async function listOpportunityHypotheses(
  sql: Sql,
  organizationId: string,
  brandId: string,
  status?: string,
): Promise<OpportunityHypothesisRecord[]> {
  if (status) {
    return sql<OpportunityHypothesisRecord>`
      select
        id,
        organization_id as "organizationId",
        brand_id as "brandId",
        hypothesis_title as "hypothesisTitle",
        angle,
        format,
        evidence_bundle_id as "evidenceBundleId",
        pattern_combination_id as "patternCombinationId",
        target_audience as "targetAudience",
        hook_direction as "hookDirection",
        rationale,
        status,
        jev_run_id as "jevRunId",
        created_at as "createdAt",
        updated_at as "updatedAt"
      from opportunity_hypotheses
      where organization_id = ${organizationId} and brand_id = ${brandId} and status = ${status}
      order by created_at desc
    `;
  }

  return sql<OpportunityHypothesisRecord>`
    select
      id,
      organization_id as "organizationId",
      brand_id as "brandId",
      hypothesis_title as "hypothesisTitle",
      angle,
      format,
      evidence_bundle_id as "evidenceBundleId",
      pattern_combination_id as "patternCombinationId",
      target_audience as "targetAudience",
      hook_direction as "hookDirection",
      rationale,
      status,
      jev_run_id as "jevRunId",
      created_at as "createdAt",
      updated_at as "updatedAt"
    from opportunity_hypotheses
    where organization_id = ${organizationId} and brand_id = ${brandId}
    order by created_at desc
  `;
}
