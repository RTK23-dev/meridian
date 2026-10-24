import { randomUUID } from "node:crypto";
import { loadBrandContext } from "../context/load.ts";
import { decideForTenant } from "../jev/engine.ts";
import { ruleDecisionRecordFields } from "../jev/decision-record.ts";
import { opportunityGate } from "../jev/questions.ts";
import { loadQuestionPolicy } from "../jev/policy.ts";
import { withTransaction, type Sql } from "../learning/store.ts";
import { readSemanticClusters } from "../embeddings/store.ts";
import type { MarketCluster } from "../intelligence/whitespace.ts";
import { rankOpportunities } from "./engine.ts";

/** Replace open opportunities from stored evidence. Does not learn and does not call a provider. */
import { priorIdeaFor, priorIdeasByFingerprint } from "./triage-memory.ts";
import { readPriorIdeas } from "./triage-memory-store.ts";

/**
 * Ranks a brand's open ideas. An idea the person declined is never put back as new. An idea already explored (accepted or briefed) is kept
 * out too, unless `keepExplored` is set: that is a deliberate new brief (forceNew), which may brief the same idea again with a stated reason.
 */
export async function rerankBrand(sql: Sql, organizationId: string, brandId: string, options: { keepExplored?: boolean } = {}): Promise<number> {
  const loaded = await loadBrandContext(sql, organizationId, brandId);
  const active = await loadQuestionPolicy(sql, organizationId, opportunityGate);
  let clusters: MarketCluster[] = [];
  try {
    const semantic = await readSemanticClusters(
      sql,
      organizationId,
      brandId,
      loaded.creatives.map((creative) => ({
        id: creative.id,
        origin: creative.origin,
        angle: creative.angle,
        text: creative.text,
      })),
    );
    clusters = semantic.clusters;
  } catch {
    clusters = [];
  }
  const drafts = rankOpportunities({ organizationId, brandId, ...loaded, clusters });
  const correlationId = randomUUID();
  let written = 0;
  // The open set is replaced as one unit. The deletes and the reinsertion share one transaction, so a failure part way
  // leaves the previous open set in place (contract section 7).
  await withTransaction(sql, async (tx) => {
    const open = await tx<{ id: string }>`
      select id from opportunities
      where brand_id = ${brandId} and organization_id = ${organizationId} and status = 'open'
    `;
    for (const row of open) {
      await tx`delete from reviews where opportunity_id = ${row.id} and status = 'open'`;
      await tx`delete from opportunities where id = ${row.id}`;
    }
    // An idea a person declined, or already explored, is not put back as new. It is counted, not written.
    const prior = await readPriorIdeas(tx, organizationId, brandId);
    const priorByKey = priorIdeasByFingerprint(options.keepExplored ? prior.filter((idea) => idea.outcome === "declined") : prior);
    for (const draft of drafts) {
      if (priorIdeaFor(draft, priorByKey) !== null) continue;
      written += 1;
      const opportunityId = randomUUID();
      const decisionId = randomUUID();
      const decision = decideForTenant(active.question, draft.gateInput, {
        organizationId,
        brandId,
        evidence: loaded.creatives,
      }, {
        policyVersion: active.policy.policyVersion,
        calibration: active.policy.calibration,
        provider: "jev",
        model: "opportunity-gate",
      });
      const evidence = [...draft.evidence, ...decision.evidence];
      const record = ruleDecisionRecordFields(decision, { input: draft.gateInput, evidence });
      await tx`
        insert into jev_decisions (
          id, organization_id, brand_id, correlation_id, question_id, question_version,
          subject_type, subject_id, input, evidence, probability, confidence, thresholds,
          decision, reasons, provider, model, answer, schema_version, policy_version, calibration_version,
          decision_fingerprint, outcome_digest
        ) values (
          ${decisionId}, ${organizationId}, ${brandId}, ${correlationId},
          ${decision.questionId}, ${decision.questionVersion}, 'opportunity', ${opportunityId},
          ${JSON.stringify(draft.gateInput)}, ${JSON.stringify(evidence)},
          ${decision.probability}, ${decision.confidence}, ${JSON.stringify(decision.thresholds)},
          ${decision.decision}, ${JSON.stringify(decision.reasons)},
          ${decision.provider}, ${decision.model}, ${JSON.stringify(decision.answer)},
          ${decision.schemaVersion}, ${decision.policyVersion}, ${decision.calibrationVersion ?? ""},
          ${record.decisionFingerprint}, ${record.outcomeDigest}
        )
      `;
      const status = decision.decision === "REJECT" ? "rejected" : "open";
      await tx`
        insert into opportunities (
          id, organization_id, brand_id, hypothesis_id, label, category, angle, hook_type, audience,
          format, proof_type, product_id, product_name, market_signal, novelty_score, brand_fit_score,
          reproducibility_score, risk_score, saturation_score, historical_score, expected_value, raw_score,
          confidence, reason, evidence, evidence_basis, supporting_ids, status, decision_id
          , research_sample_count, research_state, research_source_ids, research_analysis_ids, research_confidence
        ) values (
          ${opportunityId}, ${organizationId}, ${brandId}, ${draft.hypothesisId}, ${draft.label},
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
          values (${randomUUID()}, ${organizationId}, ${brandId}, ${decisionId}, ${opportunityId}, ${draft.label})
        `;
      }
    }
  });
  return written;
}
