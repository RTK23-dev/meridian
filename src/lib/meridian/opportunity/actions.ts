import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, type Sql } from "@/lib/db";
import { decideForTenant } from "@/lib/meridian/jev/engine";
import { opportunityGate } from "@/lib/meridian/jev/questions";
import { loadQuestionPolicy } from "@/lib/meridian/jev/policy";
import { rankOpportunities, type OpportunityDraft } from "@/lib/meridian/opportunity/engine";
import {
  id,
  asText,
  asNumber,
  asJson,
  clip,
  objectInput,
  requireBrand,
  audit,
  loadContext,
  insertDecision,
} from "../machine-shared";

export type OpportunityView = OpportunityDraft & {
  id: string;
  status: string;
  decision: string;
  probability: number;
};

export function opportunityView(row: Record<string, unknown>, decision: string, probability: number): OpportunityView {
  const evidence = asJson<{ id: string; source: string; summary: string }[]>(row.evidence, []);
  return {
    id: asText(row.id),
    hypothesisId: asText(row.hypothesis_id),
    source: asText(row.hypothesis_id).startsWith("discovered:") ? "discovered" : "prior",
    label: asText(row.label),
    category: asText(row.category),
    angle: asText(row.angle),
    hookType: asText(row.hook_type),
    audience: asText(row.audience),
    format: asText(row.format),
    proofType: asText(row.proof_type),
    productId: row.product_id ? asText(row.product_id) : null,
    productName: asText(row.product_name),
    marketSignal: asNumber(row.market_signal),
    novelty: asNumber(row.novelty_score),
    brandFit: asNumber(row.brand_fit_score),
    reproducibility: asNumber(row.reproducibility_score),
    risk: asNumber(row.risk_score),
    saturation: asNumber(row.saturation_score),
    historicalEvidence: asNumber(row.historical_score),
    expectedValue: asNumber(row.expected_value),
    rawScore: asNumber(row.raw_score),
    reason: asText(row.reason),
    evidence,
    evidenceBasis: asText(row.evidence_basis) as OpportunityDraft["evidenceBasis"],
    supportingCreativeIds: asJson<string[]>(row.supporting_ids, []),
    confidence: asNumber(row.confidence),
    researchSampleCount: asNumber(row.research_sample_count),
    researchState: asText(row.research_state),
    researchSourceIds: asJson<string[]>(row.research_source_ids, []),
    researchAnalysisIds: asJson<string[]>(row.research_analysis_ids, []),
    researchConfidence: asNumber(row.research_confidence),
    hookDirection: "",
    status: asText(row.status),
    decision,
    probability,
  };
}

export const listOpportunities = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ brandId: clip(objectInput(input).brandId, 80, "Brand", true) }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "viewer");
    const rows = await sql<Record<string, unknown>>`
      select o.*, d.decision, d.probability
      from opportunities o
      left join jev_decisions d on d.id = o.decision_id
      where o.brand_id = ${data.brandId} and o.organization_id = ${access.organizationId}
      order by o.expected_value desc, o.created_at desc
    `;
    return {
      role: access.role,
      opportunities: rows.map((row) => opportunityView(row, asText(row.decision), asNumber(row.probability))),
    };
  });

export const refreshOpportunities = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ brandId: clip(objectInput(input).brandId, 80, "Brand", true) }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    const loaded = await loadContext(sql, access.organizationId, data.brandId);
    const drafts = rankOpportunities({
      organizationId: access.organizationId,
      brandId: data.brandId,
      ...loaded,
    });
    const open = await sql<{ id: string }>`
      select id from opportunities
      where brand_id = ${data.brandId} and organization_id = ${access.organizationId} and status = 'open'
    `;
    for (const row of open) {
      await sql`delete from reviews where opportunity_id = ${row.id} and status = 'open'`;
      await sql`delete from opportunities where id = ${row.id}`;
    }
    const correlationId = id();
    const active = await loadQuestionPolicy(sql, access.organizationId, opportunityGate);
    for (const draft of drafts) {
      const opportunityId = id();
      const decisionId = id();
      const decision = decideForTenant(active.question, draft.gateInput, {
        organizationId: access.organizationId,
        brandId: data.brandId,
        evidence: loaded.creatives,
      }, {
        policyVersion: active.policy.policyVersion,
        calibration: active.policy.calibration,
        provider: "jev",
        model: "opportunity-gate",
      });
      const evidence = [...draft.evidence, ...decision.evidence];
      await insertDecision(sql, {
        id: decisionId,
        organizationId: access.organizationId,
        brandId: data.brandId,
        correlationId,
        questionId: decision.questionId,
        questionVersion: decision.questionVersion,
        subjectType: "opportunity",
        subjectId: opportunityId,
        input: draft.gateInput,
        evidence,
        probability: decision.probability,
        confidence: decision.confidence,
        thresholds: decision.thresholds,
        decision: decision.decision,
        reasons: decision.reasons,
        provider: decision.provider,
        model: decision.model,
        answer: decision.answer,
        schemaVersion: decision.schemaVersion,
        policyVersion: decision.policyVersion,
        calibrationVersion: decision.calibrationVersion,
      });
      const status = decision.decision === "REJECT" ? "rejected" : "open";
      await sql`
        insert into opportunities (
          id, organization_id, brand_id, hypothesis_id, label, category, angle, hook_type, audience,
          format, proof_type, product_id, product_name, market_signal, novelty_score, brand_fit_score,
          reproducibility_score, risk_score, saturation_score, historical_score, expected_value, raw_score,
          confidence, reason, evidence, evidence_basis, supporting_ids, status, decision_id
          , research_sample_count, research_state, research_source_ids, research_analysis_ids, research_confidence
        ) values (
          ${opportunityId}, ${access.organizationId}, ${data.brandId}, ${draft.hypothesisId}, ${draft.label},
          ${draft.category}, ${draft.angle}, ${draft.hookType}, ${draft.audience}, ${draft.format},
          ${draft.proofType}, ${draft.productId}, ${draft.productName}, ${draft.marketSignal}, ${draft.novelty},
          ${draft.brandFit}, ${draft.reproducibility}, ${draft.risk}, ${draft.saturation},
          ${draft.historicalEvidence}, ${draft.expectedValue}, ${draft.rawScore}, ${draft.confidence},
          ${draft.reason}, ${JSON.stringify(evidence)}, ${draft.evidenceBasis},
          ${JSON.stringify(draft.supportingCreativeIds)}, ${status}, ${decisionId}, ${draft.researchSampleCount},
          ${draft.researchState ?? ""}, ${JSON.stringify(draft.researchSourceIds ?? [])},
          ${JSON.stringify(draft.researchAnalysisIds ?? [])}, ${draft.researchConfidence ?? 0}
        )
      `;
      if (decision.decision === "HUMAN_REVIEW") {
        await sql`
          insert into reviews (id, organization_id, brand_id, decision_id, opportunity_id, subject_label)
          values (${id()}, ${access.organizationId}, ${data.brandId}, ${decisionId}, ${opportunityId}, ${draft.label})
        `;
      }
    }
    await audit(sql, {
      organizationId: access.organizationId,
      brandId: data.brandId,
      actorId: context.userId,
      action: "opportunities.refreshed",
      objectType: "brand",
      objectId: data.brandId,
      metadata: { count: String(drafts.length), correlationId },
    });
    return { count: drafts.length, correlationId };
  });

export async function assertOpportunityClear(sql: Sql, opportunityId: string): Promise<void> {
  const held = await sql<{ id: string }>`
    select id from reviews where opportunity_id = ${opportunityId} and status = 'open' limit 1
  `;
  if (held.length > 0) throw new Error("A person has to clear the review hold before this can move forward.");
}

export const dismissOpportunity = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return { brandId: clip(body.brandId, 80, "Brand", true), opportunityId: clip(body.opportunityId, 80, "Opportunity", true) };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    const updated = await sql<{ id: string }>`
      update opportunities set status = 'dismissed'
      where id = ${data.opportunityId} and brand_id = ${data.brandId} and organization_id = ${access.organizationId}
        and status in ('open', 'rejected')
      returning id
    `;
    if (updated.length === 0) throw new Error("That opportunity cannot be dismissed.");
    return { ok: true };
  });
