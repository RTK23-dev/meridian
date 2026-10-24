import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, type Sql } from "@/lib/db";
import { decideForTenant } from "@/lib/meridian/jev/engine";
import { opportunityGate } from "@/lib/meridian/jev/questions";
import { loadQuestionPolicy } from "@/lib/meridian/jev/policy";
import { rankOpportunities, type OpportunityDraft } from "@/lib/meridian/opportunity/engine";
import { hasRole, isRole } from "../access.ts";
import { withTransaction } from "../learning/store.ts";
import type { OpportunityDirectionInput } from "../studio/brief-service.contract.ts";
import { directionReasonProblem } from "./direction-reason.ts";
import { storedNumberOrNull } from "../decisions/stored-number.ts";
import { priorIdeaFor, priorIdeasByFingerprint } from "./triage-memory.ts";
import { readPriorIdeas, readReopenedIdeas } from "./triage-memory-store.ts";
import { TRIAGE_ACTIONS, isDirectionAction, sourceStatusProblem, statusAfter, type TriageAction } from "./triage-states.ts";
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
  /** The JEV probability, or null when no decision stored one. Null is unknown, never 0. */
  probability: number | null;
};

export function opportunityView(row: Record<string, unknown>, decision: string, probability: number | null): OpportunityView {
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

/** The latest decision on an idea, read from the row the list joins. Null when no decision was made. */
function lastDecisionOf(row: Record<string, unknown>): { action: string; reason: string; decidedAt: string } | null {
  if (row.last_action === null || row.last_action === undefined) return null;
  const at = row.last_decided_at;
  return { action: asText(row.last_action), reason: asText(row.last_reason), decidedAt: at instanceof Date ? at.toISOString() : asText(at) };
}

export const listOpportunities = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ brandId: clip(objectInput(input).brandId, 80, "Brand", true) }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "viewer");
    const rows = await sql<Record<string, unknown>>`
      select o.*, d.decision, d.probability, last.action as last_action, last.reason as last_reason, last.created_at as last_decided_at
      from opportunities o
      left join jev_decisions d on d.id = o.decision_id
      left join lateral (
        select action, reason, created_at from opportunity_direction_decisions
        where opportunity_id = o.id and organization_id = o.organization_id
        order by created_at desc limit 1
      ) last on true
      where o.brand_id = ${data.brandId} and o.organization_id = ${access.organizationId}
      order by o.expected_value desc, o.created_at desc
    `;
    return {
      role: access.role,
      opportunities: rows.map((row) => ({
        ...opportunityView(row, asText(row.decision), storedNumberOrNull(row.probability)),
        lastDecision: lastDecisionOf(row),
      })),
    };
  });

export const refreshOpportunities = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ brandId: clip(objectInput(input).brandId, 80, "Brand", true) }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => refreshOpportunitiesFor(await getSql(), context.userId, data.brandId));

/**
 * Replaces the brand's open opportunities from stored evidence. The deletes of the open set and its reinsertion, with the audit
 * record, are one transaction: a failure part way leaves the previous open set in place (contract section 7).
 */
export async function refreshOpportunitiesFor(sql: Sql, userId: string, brandId: string) {
  const access = await requireBrand(sql, userId, brandId, "member");
  const loaded = await loadContext(sql, access.organizationId, brandId);
  const drafts = rankOpportunities({
    organizationId: access.organizationId,
    brandId,
    ...loaded,
  });
  const correlationId = id();
  let suppressed = 0;
  const active = await loadQuestionPolicy(sql, access.organizationId, opportunityGate);
  await withTransaction(sql, async (tx) => {
    // The brand row is locked, so two replacements cannot both read the same open set and both insert one (review finding).
    await tx`select id from brands where id = ${brandId} for update`;
    // An open idea a person has decided on (and reopened) keeps its history: it is not deleted here.
    const open = await tx<{ id: string }>`
      select o.id from opportunities o
      where o.brand_id = ${brandId} and o.organization_id = ${access.organizationId} and o.status = 'open'
        and not exists (select 1 from opportunity_direction_decisions d where d.opportunity_id = o.id)
    `;
    for (const row of open) {
      await tx`delete from reviews where opportunity_id = ${row.id} and status = 'open'`;
      await tx`delete from opportunities where id = ${row.id}`;
    }
    // An idea a person declined, set aside or already explored, or has reopened, is not put back as new. It is counted in the audit line, not written.
    const priorByKey = priorIdeasByFingerprint([
      ...(await readPriorIdeas(tx, access.organizationId, brandId)),
      ...(await readReopenedIdeas(tx, access.organizationId, brandId)),
    ]);
    for (const draft of drafts) {
      if (priorIdeaFor(draft, priorByKey) !== null) {
        suppressed += 1;
        continue;
      }
      const opportunityId = id();
      const decisionId = id();
      const decision = decideForTenant(active.question, draft.gateInput, {
        organizationId: access.organizationId,
        brandId,
        evidence: loaded.creatives,
      }, {
        policyVersion: active.policy.policyVersion,
        calibration: active.policy.calibration,
        provider: "jev",
        model: "opportunity-gate",
      });
      const evidence = [...draft.evidence, ...decision.evidence];
      await insertDecision(tx, {
        id: decisionId,
        organizationId: access.organizationId,
        brandId,
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
      await tx`
        insert into opportunities (
          id, organization_id, brand_id, hypothesis_id, label, category, angle, hook_type, audience,
          format, proof_type, product_id, product_name, market_signal, novelty_score, brand_fit_score,
          reproducibility_score, risk_score, saturation_score, historical_score, expected_value, raw_score,
          confidence, reason, evidence, evidence_basis, supporting_ids, status, decision_id
          , research_sample_count, research_state, research_source_ids, research_analysis_ids, research_confidence
        ) values (
          ${opportunityId}, ${access.organizationId}, ${brandId}, ${draft.hypothesisId}, ${draft.label},
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
        await tx`
          insert into reviews (id, organization_id, brand_id, decision_id, opportunity_id, subject_label)
          values (${id()}, ${access.organizationId}, ${brandId}, ${decisionId}, ${opportunityId}, ${draft.label})
        `;
      }
    }
    await audit(tx, {
      organizationId: access.organizationId,
      brandId,
      actorId: userId,
      action: "opportunities.refreshed",
      objectType: "brand",
      objectId: brandId,
      metadata: { count: String(drafts.length - suppressed), suppressed: String(suppressed), correlationId },
    });
  });
  return { count: drafts.length - suppressed, suppressed, correlationId };
}

export async function assertOpportunityClear(sql: Sql, opportunityId: string): Promise<void> {
  const held = await sql<{ id: string }>`
    select id from reviews where opportunity_id = ${opportunityId} and status = 'open' limit 1
  `;
  if (held.length > 0) throw new Error("A person has to clear the review hold before this can move forward.");
}

/**
 * Records an explicit decision about an opportunity's direction: who, when, what, and why. Accepting a direction clears its
 * review hold. The decision never writes a brief's decision or a jev_decisions reviewer_decision, and it never means that a
 * brief passed its gate. Each brief is judged when it is written (studio/brief-service.server.ts).
 */
export async function recordOpportunityDirection(
  sql: Sql,
  input: OpportunityDirectionInput,
): Promise<{ directionId: string; opportunityStatus: string }> {
  if (!isRole(input.actorRole) || !hasRole(input.actorRole, "member")) {
    throw new Error("Only a member or higher can decide an opportunity's direction.");
  }
  if (!isDirectionAction(input.action)) {
    throw new Error("Choose approve, decline, save, defer, request more research or reopen.");
  }
  const problem = directionReasonProblem(input.reason);
  if (problem) throw new Error(problem);
  const reason = input.reason.trim();
  const directionId = globalThis.crypto.randomUUID();
  // The opportunity leaves 'open' (or a held state) with its decision. Ranking deletes open opportunities, and a direction row must not be
  // deleted with them, so each action sets a status that ranking keeps (triage-states.ts).
  const opportunityStatus = statusAfter(input.action);
  return withTransaction(sql, async (tx) => {
    const [opportunity] = await tx<{ id: string; status: string }>`
      select id, status from opportunities
      where id = ${input.opportunityId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
      limit 1 for update
    `;
    if (!opportunity) throw new Error("Opportunity not found.");
    const refusal = sourceStatusProblem(input.action, opportunity.status);
    if (refusal) throw new Error(refusal);
    await tx`
      insert into opportunity_direction_decisions (
        id, organization_id, brand_id, opportunity_id, actor_id, actor_role, action, reason
      ) values (
        ${directionId}, ${input.organizationId}, ${input.brandId}, ${input.opportunityId}, ${input.actorId},
        ${input.actorRole}, ${input.action}, ${reason}
      )
    `;
    // Approving or declining settles the review hold on the idea. A hold, or a reopen, leaves the review as it was.
    if (input.action === "approve" || input.action === "decline") {
      await tx`
        update reviews set status = ${input.action === "approve" ? "approved" : "rejected"}
        where opportunity_id = ${input.opportunityId} and organization_id = ${input.organizationId} and status = 'open'
      `;
    }
    await tx`
      update opportunities set status = ${opportunityStatus}
      where id = ${input.opportunityId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
    `;
    await audit(tx, {
      organizationId: input.organizationId,
      brandId: input.brandId,
      actorId: input.actorId,
      action: `opportunity.direction.${input.action}`,
      objectType: "opportunity",
      objectId: input.opportunityId,
      metadata: { directionId, actorRole: input.actorRole, opportunityStatus },
    });
    return { directionId, opportunityStatus };
  });
}

/**
 * Holds an open idea (save, defer, request more research), reopens a held one, or declines it, from the Opportunities screen. The reason is
 * required and is kept with the decision. A refresh keeps a held or declined idea out (triage-memory.ts). Approving is not offered here:
 * Studio takes that decision, because it writes the brief from it.
 */
export const triageOpportunity = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    const action = clip(body.action, 40, "Action", true);
    if (!(TRIAGE_ACTIONS as readonly string[]).includes(action)) {
      throw new Error("Choose decline, save, defer, request more research or reopen.");
    }
    return {
      brandId: clip(body.brandId, 80, "Brand", true),
      opportunityId: clip(body.opportunityId, 80, "Opportunity", true),
      action: action as TriageAction,
      reason: clip(body.reason, 2000, "Reason", true),
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    return recordOpportunityDirection(sql, {
      organizationId: access.organizationId,
      brandId: data.brandId,
      opportunityId: data.opportunityId,
      actorId: context.userId,
      actorRole: access.role,
      action: data.action,
      reason: data.reason,
    });
  });

/**
 * Declines several open ideas with one reason. Each idea goes through the same decision as a single decline: a decision row with its reason,
 * the audit line, and the review settled. An idea that cannot be declined is returned with the reason, and the others are still declined.
 */
export const dismissOpportunity = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    const raw = Array.isArray(body.opportunityIds) ? body.opportunityIds : [];
    const opportunityIds = [...new Set(raw.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 80)).filter((item) => item.length > 0))];
    if (opportunityIds.length === 0 || opportunityIds.length > 50) throw new Error("Choose between 1 and 50 ideas to decline.");
    return {
      brandId: clip(body.brandId, 80, "Brand", true),
      opportunityIds,
      reason: clip(body.reason, 2000, "Reason", true),
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const problem = directionReasonProblem(data.reason);
    if (problem) throw new Error(problem);
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    const declined: string[] = [];
    const skipped: Array<{ opportunityId: string; reason: string }> = [];
    for (const opportunityId of data.opportunityIds) {
      try {
        await recordOpportunityDirection(sql, {
          organizationId: access.organizationId,
          brandId: data.brandId,
          opportunityId,
          actorId: context.userId,
          actorRole: access.role,
          action: "decline",
          reason: data.reason,
        });
        declined.push(opportunityId);
      } catch (error) {
        skipped.push({ opportunityId, reason: error instanceof Error ? error.message : "The idea could not be declined." });
      }
    }
    return { declined, skipped };
  });
