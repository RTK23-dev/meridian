import { randomUUID } from "node:crypto";
import { loadBrandContext } from "../context/load.ts";
import { decide } from "../jev/engine.ts";
import { opportunityGate } from "../jev/questions.ts";
import type { Sql } from "../learning/store.ts";
import { approvedThresholds } from "../calibration/active.ts";
import { readSemanticClusters } from "../embeddings/store.ts";
import type { MarketCluster } from "../intelligence/whitespace.ts";
import { rankOpportunities } from "./engine.ts";

/** Replace open opportunities from stored evidence. Does not learn and does not call a provider. */
export async function rerankBrand(sql: Sql, organizationId: string, brandId: string): Promise<number> {
  const loaded = await loadBrandContext(sql, organizationId, brandId);
  const versions = await sql<{ thresholds: string }>`
    select thresholds from jev_threshold_versions
    where organization_id = ${organizationId} and question_id = ${opportunityGate.id}
    order by version desc
    limit 1
  `;
  const thresholds = approvedThresholds(opportunityGate.thresholds, versions[0] ?? null);
  const question = { ...opportunityGate, thresholds };
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
  const open = await sql<{ id: string }>`
    select id from opportunities
    where brand_id = ${brandId} and organization_id = ${organizationId} and status = 'open'
  `;
  for (const row of open) {
    await sql`delete from reviews where opportunity_id = ${row.id} and status = 'open'`;
    await sql`delete from opportunities where id = ${row.id}`;
  }
  const correlationId = randomUUID();
  for (const draft of drafts) {
    const opportunityId = randomUUID();
    const decisionId = randomUUID();
    const decision = decide(question, draft.gateInput);
    const evidence = [...draft.evidence, ...decision.evidence];
    await sql`
      insert into jev_decisions (
        id, organization_id, brand_id, correlation_id, question_id, question_version,
        subject_type, subject_id, input, evidence, probability, confidence, thresholds,
        decision, reasons
      ) values (
        ${decisionId}, ${organizationId}, ${brandId}, ${correlationId},
        ${decision.questionId}, ${decision.questionVersion}, 'opportunity', ${opportunityId},
        ${JSON.stringify(draft.gateInput)}, ${JSON.stringify(evidence)},
        ${decision.probability}, ${decision.confidence}, ${JSON.stringify(decision.thresholds)},
        ${decision.decision}, ${JSON.stringify(decision.reasons)}
      )
    `;
    const status = decision.decision === "REJECT" ? "rejected" : "open";
    await sql`
      insert into opportunities (
        id, organization_id, brand_id, hypothesis_id, label, category, angle, hook_type, audience,
        format, proof_type, product_id, product_name, market_signal, novelty_score, brand_fit_score,
        reproducibility_score, risk_score, saturation_score, historical_score, expected_value, raw_score,
        confidence, reason, evidence, evidence_basis, supporting_ids, status, decision_id
      ) values (
        ${opportunityId}, ${organizationId}, ${brandId}, ${draft.hypothesisId}, ${draft.label},
        ${draft.category}, ${draft.angle}, ${draft.hookType}, ${draft.audience}, ${draft.format},
        ${draft.proofType}, ${draft.productId}, ${draft.productName}, ${draft.marketSignal}, ${draft.novelty},
        ${draft.brandFit}, ${draft.reproducibility}, ${draft.risk}, ${draft.saturation},
        ${draft.historicalEvidence}, ${draft.expectedValue}, ${draft.rawScore}, ${draft.confidence},
        ${draft.reason}, ${JSON.stringify(evidence)}, ${draft.evidenceBasis},
        ${JSON.stringify(draft.supportingCreativeIds)}, ${status}, ${decisionId}
      )
    `;
    if (decision.decision === "HUMAN_REVIEW") {
      await sql`
        insert into reviews (id, organization_id, brand_id, decision_id, opportunity_id, subject_label)
        values (${randomUUID()}, ${organizationId}, ${brandId}, ${decisionId}, ${opportunityId}, ${draft.label})
      `;
    }
  }
  return drafts.length;
}
