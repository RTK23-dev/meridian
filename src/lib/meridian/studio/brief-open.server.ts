/**
 * Accepts a discovered direction and writes its brief: the work behind the studio's "open brief" action. A person accepts the
 * direction with a written reason, the brief is built from the stored evidence and judged by the shared brief gate, and the
 * brief is written through createGatedBrief. A person may name the opportunity to brief; without one, the top discovered
 * direction is used. Server-only: the server function in actions.ts loads this module on demand.
 */
import { requireBrand } from "../brand-membership.ts";
import { buildBrief } from "../brief/engine.ts";
import { loadBrandContext } from "../context/load.ts";
import { assertSameTenant } from "../domain.ts";
import { readSemanticClusters } from "../embeddings/store.ts";
import type { Sql } from "../learning/store.ts";
import type { MarketCluster } from "../intelligence/whitespace.ts";
import { recordOpportunityDirection } from "../opportunity/actions.ts";
import { hypothesisById } from "../opportunity/catalog.ts";
import { directionReasonProblem } from "../opportunity/direction-reason.ts";
import { rankOpportunities, type OpportunityDraft } from "../opportunity/engine.ts";
import { rerankBrand } from "../opportunity/rerank.ts";
import { asJson, asNumber, asText } from "../machine-shared.ts";
import { briefBrainFrom, briefGateJudge, createGatedBrief, type BriefGateOptions } from "./brief-service.server.ts";
import type { BriefGateResult } from "./brief-gate.server.ts";

export type OpenStudioBriefInput = {
  brandId: string;
  forceNew: boolean;
  reason: string;
  /** The opportunity to brief, as the person chose it. It must be open, discovered, and in this brand. */
  opportunityId?: string;
};

function hookFor(hypothesisId: string): string {
  return hypothesisById(hypothesisId)?.hookLine || "Keep the observed structure. Do not copy the competitor's wording.";
}

/**
 * The opportunity the person named. It is checked for tenancy (organization and brand) and for the state a brief needs. It is
 * read as stored: the ranking is not rebuilt, because a rebuild replaces every open opportunity with a new id.
 */
async function chosenOpportunity(sql: Sql, organizationId: string, brandId: string, opportunityId: string) {
  const [row] = await sql<Record<string, unknown>>`
    select o.*, d.decision
    from opportunities o
    left join jev_decisions d on d.id = o.decision_id
    where o.id = ${opportunityId} and o.brand_id = ${brandId} and o.organization_id = ${organizationId}
    limit 1
  `;
  if (!row) throw new Error("Opportunity not found.");
  const status = asText(row.status);
  if (status !== "open") throw new Error(`This opportunity cannot be briefed now, because it is ${status}. Choose an open one.`);
  if (!asText(row.hypothesis_id).startsWith("discovered:")) throw new Error("Only a discovered direction can be briefed here.");
  return row;
}

/** The top discovered direction after a fresh ranking. The open set is rebuilt first, as it always was for this action. */
async function topDiscoveredOpportunity(
  sql: Sql,
  organizationId: string,
  brandId: string,
  loaded: Awaited<ReturnType<typeof loadBrandContext>>,
) {
  let clusters: MarketCluster[] = [];
  try {
    clusters = (
      await readSemanticClusters(
        sql,
        organizationId,
        brandId,
        loaded.creatives.map((creative) => ({ id: creative.id, origin: creative.origin, angle: creative.angle, text: creative.text })),
      )
    ).clusters;
  } catch {
    clusters = [];
  }
  const ranked = rankOpportunities({ organizationId, brandId, ...loaded, clusters });
  const top = ranked.find((item) => item.source === "discovered");
  if (!top) throw new Error("No discovered opportunity. Stored observations do not show a direction outside the exploration seeds.");
  const rows = await sql<Record<string, unknown>>`
    select o.*, d.decision
    from opportunities o
    left join jev_decisions d on d.id = o.decision_id
    where o.brand_id = ${brandId} and o.organization_id = ${organizationId}
      and o.angle = ${top.angle} and o.status = 'open'
    order by o.expected_value desc
    limit 1
  `;
  const row = rows[0];
  if (!row) throw new Error("The discovered direction was not stored. Refresh did not write it.");
  return row;
}

/**
 * Accepts the direction and writes its brief. Each step runs in the order the contract gives: the reason is checked, the direction
 * is recorded with who, when, what and why, and then the brief is judged and written. A rejected brief reopens its direction
 * (studio/brief-direction.server.ts). A replacement (forceNew) retires the older ready brief in the same transaction as the new one.
 */
export async function openStudioBriefFor(
  sql: Sql,
  userId: string,
  data: OpenStudioBriefInput,
  gate: BriefGateOptions = {},
): Promise<void> {
  const access = await requireBrand(sql, userId, data.brandId, "member");
  // The reason is checked before anything is ranked or written, so a refused accept changes nothing.
  const reasonProblem = directionReasonProblem(data.reason);
  if (reasonProblem) throw new Error(reasonProblem);
  if (!data.opportunityId) await rerankBrand(sql, access.organizationId, data.brandId);
  const loaded = await loadBrandContext(sql, access.organizationId, data.brandId);
  assertSameTenant(loaded.creatives, access.organizationId, data.brandId);
  const row = data.opportunityId
    ? await chosenOpportunity(sql, access.organizationId, data.brandId, data.opportunityId)
    : await topDiscoveredOpportunity(sql, access.organizationId, data.brandId, loaded);
  if (asText(row.decision) === "REJECT" || asText(row.status) === "rejected") {
    throw new Error("JEV rejected this direction. A brief was not written.");
  }
  const opportunityId = asText(row.id);
  // The direction is recorded first, as its own decision. It writes no brief decision and does not mean that the brief passed
  // its gate. The brief is judged by createGatedBrief below, and a rejected brief reopens the direction it was written for.
  await recordOpportunityDirection(sql, {
    organizationId: access.organizationId,
    brandId: data.brandId,
    opportunityId,
    actorId: userId,
    actorRole: access.role,
    action: "approve",
    reason: data.reason,
  });
  const existing = data.forceNew
    ? []
    : await sql<{ id: string }>`
        select id from briefs
        where opportunity_id = ${opportunityId} and status = 'ready' and organization_id = ${access.organizationId}
        order by created_at desc limit 1
      `;
  if (existing[0]) return;

  const draft: OpportunityDraft = {
    hypothesisId: asText(row.hypothesis_id),
    source: "discovered",
    label: asText(row.label),
    category: asText(row.category),
    angle: asText(row.angle),
    hookType: asText(row.hook_type),
    audience: asText(row.audience),
    format: asText(row.format),
    proofType: asText(row.proof_type),
    productId: row.product_id ? asText(row.product_id) : null,
    productName: asText(row.product_name) || loaded.products[0]?.name || "",
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
    evidence: asJson(row.evidence, []),
    evidenceBasis: asText(row.evidence_basis) as OpportunityDraft["evidenceBasis"],
    supportingCreativeIds: asJson(row.supporting_ids, []),
    confidence: asNumber(row.confidence),
    hookDirection: hookFor(asText(row.hypothesis_id)),
  };
  const documents = await sql<{ id: string; excerpt: string }>`
    select id, excerpt from source_documents
    where brand_id = ${data.brandId} and organization_id = ${access.organizationId} and status = 'stored'
    order by created_at desc
    limit 6
  `;
  const brief = buildBrief({
    opportunity: draft,
    brain: loaded.brain,
    patterns: loaded.patterns,
    rejections: loaded.rejections,
    observations: documents.map((document) => ({ id: document.id, text: document.excerpt })),
  });
  for (const pattern of loaded.patterns.filter((item) => item.lift < 0)) {
    const line = `Do not prefer ${pattern.attribute}=${pattern.value}.`;
    if (!brief.constraints.includes(line)) brief.constraints = `${brief.constraints}\n${line} ${pattern.summary}`.trim();
  }
  if (!brief.cta.trim()) brief.cta = "See it in use";
  brief.why.push("Success would test whether this direction beats this brand's stored baseline without copying a competitor line.");
  const outcome: { result?: BriefGateResult } = {};
  const judge = briefGateJudge(sql, {
    organizationId: access.organizationId,
    brandId: data.brandId,
    brief: {
      audience: brief.audience,
      hook: brief.hook,
      message: brief.message,
      format: brief.format,
      cta: brief.cta,
      angle: brief.angle,
      offer: brief.offer,
    },
    brain: briefBrainFrom(loaded.brain),
    ...gate,
  });
  const created = await createGatedBrief(sql, {
    organizationId: access.organizationId,
    brandId: data.brandId,
    createdBy: userId,
    brief: {
      opportunityId,
      title: brief.title,
      audience: brief.audience,
      angle: brief.angle,
      hook: brief.hook,
      message: brief.message,
      offer: brief.offer,
      cta: brief.cta,
      format: brief.format,
      proofType: brief.proofType,
      constraints: brief.constraints,
      context: brief.context,
      workflow: brief.workflow,
      why: brief.why,
      learningNotes: brief.learningNotes,
      failureNotes: brief.failureNotes,
    },
    supersedeReady: data.forceNew,
    judge: async (briefId) => {
      outcome.result = await judge(briefId);
      return outcome.result;
    },
  });
  // A rejected brief is stored, so the rejection is on record, but it is not used. The person is told why.
  if (created.status === "rejected") {
    throw new Error(`The brief gate rejected this: ${outcome.result?.reason ?? "no reason was recorded"}. A person was not asked to ignore a stored rejection.`);
  }
}
