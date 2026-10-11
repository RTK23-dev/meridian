/**
 * Reads the decision calibration report for one brand from its stored decisions. The observed outcome is the reviewer's
 * decision (approve or reject). The stated probability is the decision's stored probability. Decisions with no stored
 * probability, and decisions no reviewer has decided, are not outcomes and are not read.
 */
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertRole, isRole } from "@/lib/meridian/access";
import { buildCalibrationReport, type CalibrationReportState } from "./calibration-report.ts";

/** The most recent reviewed decisions the report reads. The report says how many it used. */
export const CALIBRATION_REPORT_ROW_LIMIT = 5000;

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

export const getDecisionCalibrationReport = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const brandId = input && typeof input === "object" && typeof (input as { brandId?: unknown }).brandId === "string" ? (input as { brandId: string }).brandId : "";
    if (!brandId) throw new Error("Choose a brand.");
    return { brandId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }): Promise<CalibrationReportState> => {
    const { sql, organizationId, role } = await brandRole(context.userId, data.brandId);
    assertRole(role, "admin");
    const rows = await sql<{ probability: number | string; reviewer_decision: string }>`
      select probability, reviewer_decision from jev_decisions
      where organization_id = ${organizationId} and brand_id = ${data.brandId}
        and reviewer_decision in ('approve', 'reject') and probability is not null
      order by created_at desc
      limit ${CALIBRATION_REPORT_ROW_LIMIT}
    `;
    return buildCalibrationReport(
      rows.map((row) => ({ predicted: Number(row.probability), observed: row.reviewer_decision === "approve" })),
    );
  });
