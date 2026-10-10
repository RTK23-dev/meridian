/**
 * Writes a brief from a stored opportunity. Server-only: the creative action's handler loads this module, so the client bundle
 * never imports the brief service through the route tree. The brief is judged by the shared brief gate and written through
 * createGatedBrief, as every brief is.
 */
import { getSql } from "../../db.ts";
import { buildBrief } from "../brief/engine.ts";
import { selectContext } from "../retrieval/pack.ts";
import { asText, loadContext, requireBrand } from "../machine-shared.ts";
import { assertOpportunityClear, opportunityView } from "../opportunity/actions.ts";
import { briefBrainFrom, briefGateJudge, createGatedBrief, type BriefGateOptions } from "./brief-service.server.ts";

/**
 * Writes a brief from a stored opportunity for a signed-in user. The role and the tenant are checked here. The brief is judged
 * by the shared brief gate and written through createGatedBrief, as every brief is. No local rule set decides it.
 */
export async function createBriefFromOpportunityFor(
  userId: string,
  data: { brandId: string; opportunityId: string },
  gate: BriefGateOptions = {},
) {
  const sql = await getSql();
  const access = await requireBrand(sql, userId, data.brandId, "member");
  const rows = await sql<Record<string, unknown>>`
    select * from opportunities
    where id = ${data.opportunityId} and brand_id = ${data.brandId} and organization_id = ${access.organizationId}
    limit 1
  `;
  const row = rows[0];
  if (!row) throw new Error("Opportunity not found.");
  if (asText(row.status) === "rejected" || asText(row.status) === "dismissed") {
    throw new Error("This opportunity was rejected or dismissed.");
  }
  await assertOpportunityClear(sql, data.opportunityId);
  const existing = await sql<{ id: string }>`
    select id from briefs
    where opportunity_id = ${data.opportunityId} and status = 'ready' and organization_id = ${access.organizationId}
    order by created_at desc limit 1
  `;
  if (existing[0]) return { id: existing[0].id };
  const loaded = await loadContext(sql, access.organizationId, data.brandId);
  const draft = opportunityView(row, "", 0);
  const sameAngle = loaded.creatives
    .filter((creative) => creative.origin === "competitor" && creative.angle === draft.angle && creative.text)
    .slice(0, 4)
    .map((creative) => ({ id: creative.id, text: creative.text }));
  const retrieved = selectContext(
    `${draft.angle} ${draft.hookDirection}`,
    loaded.creatives
      .filter((creative) => creative.origin === "competitor")
      .map((creative) => ({ id: creative.id, brandId: creative.brandId, text: creative.text })),
    data.brandId,
  );
  const observations = (retrieved.length > 0 ? retrieved : sameAngle).map((item) => ({ id: item.id, text: item.text }));
  const brief = buildBrief({
    opportunity: draft,
    brain: loaded.brain,
    patterns: loaded.patterns,
    rejections: loaded.rejections,
    observations,
  });
  const created = await createGatedBrief(sql, {
    organizationId: access.organizationId,
    brandId: data.brandId,
    createdBy: userId,
    brief: {
      opportunityId: data.opportunityId,
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
    judge: briefGateJudge(sql, {
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
    }),
  });
  return { id: created.briefId, decision: created.action };
}

