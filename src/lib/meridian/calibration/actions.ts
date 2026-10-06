import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertRole, isRole } from "@/lib/meridian/access";
import { approveThresholdChange, proposeThresholdChange, type ThresholdProposal } from "./propose.ts";
import { calibrationVisible, proposalCreateDecision, reviewerRowsFromStored } from "./scope.ts";

async function brandRole(userId: string, brandId: string) {
  const sql = await getSql();
  const rows = await sql<{ organization_id: string; role: string }>`
    select b.organization_id, m.role
    from brands b
    join memberships m on m.organization_id = b.organization_id and m.user_id = ${userId}
    where b.id = ${brandId} and b.deleted_at is null
    limit 1
  `;
  const row = rows[0];
  if (!row || !isRole(row.role)) throw new Error("That brand is not available to you.");
  return { sql, organizationId: row.organization_id, role: row.role };
}

export const getCalibration = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const brandId = input && typeof input === "object" && typeof (input as { brandId?: unknown }).brandId === "string" ? (input as { brandId: string }).brandId : "";
    if (!brandId) throw new Error("Choose a brand.");
    return { brandId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { sql, organizationId } = await brandRole(context.userId, data.brandId);
    const proposals = await sql<{ id: string; question_id: string; proposed: string; status: string }>`
      select id, question_id, proposed, status from calibration_proposals
      where organization_id = ${organizationId} and brand_id = ${data.brandId}
      order by created_at desc
      limit 10
    `;
    const versions = await sql<{ id: string; question_id: string; version: number; thresholds: string; approved_by: string }>`
      select id, question_id, version, thresholds, approved_by from jev_threshold_versions
      where organization_id = ${organizationId}
      order by version desc
      limit 10
    `;
    return {
      proposals: proposals.map((row) => {
        let samples: number | null = null;
        let disagreement: number | null = null;
        let current = "";
        let proposedThresholds = "";
        try {
          const parsed = JSON.parse(row.proposed) as { samples?: number; disagreement?: number; current?: unknown; proposed?: unknown };
          samples = typeof parsed.samples === "number" ? parsed.samples : null;
          disagreement = typeof parsed.disagreement === "number" ? parsed.disagreement : null;
          current = JSON.stringify(parsed.current ?? {});
          proposedThresholds = JSON.stringify(parsed.proposed ?? {});
        } catch {
          proposedThresholds = row.proposed;
        }
        return { id: row.id, questionId: row.question_id, proposed: row.proposed, status: row.status, samples, disagreement, current, proposedThresholds };
      }),
      versions: versions.map((row) => ({ id: row.id, questionId: row.question_id, version: row.version, thresholds: row.thresholds, approvedBy: row.approved_by })),
    };
  });

export const decideCalibration = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as { brandId?: unknown; proposalId?: unknown; decision?: unknown }) : {};
    const brandId = typeof body.brandId === "string" ? body.brandId : "";
    const proposalId = typeof body.proposalId === "string" ? body.proposalId : "";
    const decision = body.decision === "approved" || body.decision === "rejected" ? body.decision : "";
    if (!brandId || !proposalId || !decision) throw new Error("A calibration decision needs a brand, a proposal, and approve or reject.");
    return { brandId, proposalId, decision };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { sql, organizationId, role } = await brandRole(context.userId, data.brandId);
    assertRole(role, "admin");
    const rows = await sql<{ id: string; organization_id: string; question_id: string; proposed: string; status: string }>`
      select id, organization_id, question_id, proposed, status from calibration_proposals
      where id = ${data.proposalId} and organization_id = ${organizationId} and brand_id = ${data.brandId}
      limit 1
    `;
    const row = rows[0];
    if (!row || !calibrationVisible({ organizationId: row.organization_id, brandId: data.brandId }, { organizationId, brandId: data.brandId })) {
      throw new Error("That proposal is not in this workspace.");
    }
    if (row.status !== "proposed") throw new Error("That proposal is already decided.");
    if (data.decision === "rejected") {
      await sql`update calibration_proposals set status = 'rejected' where id = ${row.id}`;
      await sql`
        insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
        values (${crypto.randomUUID()}, ${organizationId}, ${data.brandId}, ${context.userId}, 'calibration.rejected', 'calibration_proposal', ${row.id}, '{}')
      `;
      return { status: "rejected" as const };
    }
    const proposal = JSON.parse(row.proposed) as ThresholdProposal;
    const current = await sql<{ version: number }>`
      select version from jev_threshold_versions
      where organization_id = ${organizationId} and question_id = ${row.question_id}
      order by version desc limit 1
    `;
    const approved = approveThresholdChange(proposal, context.userId, current[0]?.version ?? 0);
    const versionId = crypto.randomUUID();
    await sql`
      insert into jev_threshold_versions (id, organization_id, question_id, version, thresholds, approved_by)
      values (${versionId}, ${organizationId}, ${approved.questionId}, ${approved.version}, ${JSON.stringify(approved.thresholds)}, ${approved.approvedBy})
    `;
    await sql`update calibration_proposals set status = 'approved' where id = ${row.id}`;
    await sql`
      insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
      values (${crypto.randomUUID()}, ${organizationId}, ${data.brandId}, ${context.userId}, 'calibration.approved', 'jev_threshold_version', ${versionId}, ${JSON.stringify({ version: approved.version })})
    `;
    await sql`
      insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
      values (${crypto.randomUUID()}, ${organizationId}, ${data.brandId}, ${context.userId}, 'calibration.active_changed', 'jev_threshold_version', ${versionId}, ${JSON.stringify({ version: approved.version })})
    `;
    return { status: "approved" as const, version: approved.version };
  });

export const proposeCalibration = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const brandId = input && typeof input === "object" && typeof (input as { brandId?: unknown }).brandId === "string" ? (input as { brandId: string }).brandId : "";
    if (!brandId) throw new Error("Choose a brand.");
    return { brandId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { sql, organizationId, role } = await brandRole(context.userId, data.brandId);
    assertRole(role, "admin");
    const open = await sql<{ status: string }>`
      select status from calibration_proposals
      where organization_id = ${organizationId} and brand_id = ${data.brandId} and question_id = 'opportunity_gate'
    `;
    if (proposalCreateDecision(open.map((row) => row.status)) === "already_open") {
      return { status: "already_open" as const, detail: "A proposal is already waiting. Thresholds were not changed." };
    }
    const decisions = await sql<{ probability: number; reviewer_decision: string | null }>`
      select probability, reviewer_decision from jev_decisions
      where organization_id = ${organizationId} and brand_id = ${data.brandId} and question_id = 'opportunity_gate' and reviewer_decision is not null
    `;
    const rows = reviewerRowsFromStored(decisions.map((row) => ({ probability: Number(row.probability), reviewerDecision: row.reviewer_decision })));
    const versions = await sql<{ thresholds: string }>`
      select thresholds from jev_threshold_versions
      where organization_id = ${organizationId} and question_id = 'opportunity_gate'
      order by version desc limit 1
    `;
    let current = { autoApprove: 0.8, humanReview: 0.4 };
    if (versions[0]?.thresholds) {
      try {
        const parsed = JSON.parse(versions[0].thresholds) as { autoApprove?: number; humanReview?: number };
        if (typeof parsed.autoApprove === "number" && typeof parsed.humanReview === "number") current = { autoApprove: parsed.autoApprove, humanReview: parsed.humanReview };
      } catch {
        current = { autoApprove: 0.8, humanReview: 0.4 };
      }
    }
    const proposed = proposeThresholdChange({ questionId: "opportunity_gate", current, rows });
    if (proposed.status !== "proposed" || !proposed.proposal) {
      return { status: "insufficient" as const, samples: rows.length, detail: "Not enough reviewer disagreement to propose a change. Thresholds were not changed." };
    }
    const id = crypto.randomUUID();
    await sql`
      insert into calibration_proposals (id, organization_id, brand_id, question_id, proposed, status)
      values (${id}, ${organizationId}, ${data.brandId}, 'opportunity_gate', ${JSON.stringify(proposed.proposal)}, 'proposed')
    `;
    await sql`
      insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
      values (${crypto.randomUUID()}, ${organizationId}, ${data.brandId}, ${context.userId}, 'calibration.proposed', 'calibration_proposal', ${id}, ${JSON.stringify({ samples: proposed.proposal.samples })})
    `;
    return { status: "proposed" as const, samples: proposed.proposal.samples, disagreement: proposed.proposal.disagreement };
  });
