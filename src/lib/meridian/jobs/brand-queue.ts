/**
 * The production queue for one brand, read from the jobs table: a count for each status and the most recent jobs, each with its
 * own failure reason. Anyone who can view the brand may read it, because it is the brand's own work. Payload values are never
 * returned, only the names of their fields, as the workspace jobs screen does. No duration is estimated, because the jobs table
 * has no start time.
 */
import { requireBrand } from "../brand-membership.ts";
import type { Sql } from "../learning/store.ts";
import { countsByStatus, JOB_STATUSES, jobView, type JobView } from "./ops.ts";

export const BRAND_QUEUE_RECENT = 12;

export type BrandProductionQueue = {
  /** A count for every known status. A status with no jobs is 0, never missing. */
  counts: Record<(typeof JOB_STATUSES)[number], number>;
  /** Every job for the brand, in any status. */
  total: number;
  /** The most recent jobs for the brand, newest first. */
  recent: JobView[];
};

export async function brandProductionQueue(sql: Sql, userId: string, brandId: string): Promise<BrandProductionQueue> {
  const { organizationId } = await requireBrand(sql, userId, brandId, "viewer");
  const [countRows, rows] = await Promise.all([
    sql<{ status: string; count: unknown }>`
      select status, count(*) as count from jobs
      where organization_id = ${organizationId} and brand_id = ${brandId}
      group by status
    `,
    sql<Record<string, unknown>>`
      select j.id, j.brand_id, coalesce(b.name, '') as brand_name, j.job_type, j.status, j.attempts, j.max_attempts,
        j.last_error, j.payload, j.created_at, j.updated_at, j.run_after, j.cancel_requested
      from jobs j
      left join brands b on b.id = j.brand_id and b.organization_id = j.organization_id
      where j.organization_id = ${organizationId} and j.brand_id = ${brandId}
      order by j.created_at desc, j.id desc
      limit ${BRAND_QUEUE_RECENT}
    `,
  ]);
  const byStatus = countsByStatus(countRows);
  const counts = Object.fromEntries(JOB_STATUSES.map((status) => [status, byStatus[status] ?? 0])) as BrandProductionQueue["counts"];
  const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
  return { counts, total, recent: rows.map((row) => jobView(row)) };
}
