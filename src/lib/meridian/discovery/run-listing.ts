/**
 * The recent discovery runs of one brand, with each source's state and reason, for the Market screen. Every row is read
 * inside the workspace and brand scope, so a run of another brand or workspace is never listed.
 */
import type { Sql } from "../learning/store.ts";
import { progressFromRow } from "./service.ts";
import type { DiscoveryRunStatus, DiscoveryScope, SourceRunState } from "./types.ts";

export type DiscoveryRunSummary = {
  id: string;
  scope: DiscoveryScope;
  status: DiscoveryRunStatus;
  seeds: string[];
  startedAt: string;
  completedAt: string | null;
  caveat: string | null;
  /** Items this run stored. */
  discoveredUrls: number;
  /** Records this run matched to ones already stored for the brand. */
  seenBefore: number;
  /** One entry per source and seed. A source that did not run says why. */
  sources: SourceRunState[];
};

export async function listDiscoveryRuns(
  sql: Sql,
  input: { organizationId: string; brandId: string; limit?: number },
): Promise<DiscoveryRunSummary[]> {
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 5)), 20);
  const rows = await sql<Record<string, unknown>>`
    select id, scope, status, seeds, progress, started_at, completed_at
    from discovery_runs
    where organization_id = ${input.organizationId} and brand_id = ${input.brandId}
    order by started_at desc
    limit ${limit}
  `;
  return rows.map((row) => {
    const { progress, caveat } = progressFromRow(row.progress);
    const seeds = Array.isArray(row.seeds) ? row.seeds : typeof row.seeds === "string" ? JSON.parse(row.seeds) as unknown[] : [];
    return {
      id: String(row.id),
      scope: row.scope as DiscoveryScope,
      status: row.status as DiscoveryRunStatus,
      seeds: seeds.map(String),
      startedAt: String(row.started_at),
      completedAt: row.completed_at ? String(row.completed_at) : null,
      caveat: caveat ?? null,
      discoveredUrls: progress.discoveredUrls,
      seenBefore: progress.seenBefore ?? 0,
      sources: progress.sources ?? [],
    };
  });
}
