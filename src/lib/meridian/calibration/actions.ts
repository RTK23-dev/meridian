import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertRole, isRole } from "@/lib/meridian/access";
import { approveThresholdChange, type ThresholdProposal } from "./propose.ts";

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
      proposals: proposals.map((row) => ({ id: row.id, questionId: row.question_id, proposed: row.proposed, status: row.status })),
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
    const rows = await sql<{ id: string; question_id: string; proposed: string; status: string }>`
      select id, question_id, proposed, status from calibration_proposals
      where id = ${data.proposalId} and organization_id = ${organizationId} and brand_id = ${data.brandId}
      limit 1
    `;
    const row = rows[0];
    if (!row) throw new Error("That proposal is not in this workspace.");
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
    return { status: "approved" as const, version: approved.version };
  });
