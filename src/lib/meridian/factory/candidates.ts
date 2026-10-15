// Reads the Instagram candidates of the brand's recent Factory runs, with each one's latest tier (B2). Every query is scoped to the
// organization and the brand. The rows are data from Apify and from the rater; they are shown as text, never as markup.

import type { Sql } from "../learning/store.ts";
import { RECENT_RUNS_LIMIT } from "./gather.ts";
import {
  CANDIDATES_SHOWN_PER_RUN,
  type CandidateTier,
  type RunCandidate,
  type RunCandidateSummary,
} from "./candidate-types.ts";

function tierOf(value: string | null): CandidateTier | null {
  return value === "S" || value === "A" || value === "B" || value === "C" ? value : null;
}

function numberOrNull(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

/** Each recent run's candidates: the counts by tier, and the newest few. A run with no candidates has no entry. */
export async function factoryRunCandidatesFor(sql: Sql, organizationId: string, brandId: string): Promise<Map<string, RunCandidateSummary>> {
  const byRun = new Map<string, RunCandidateSummary>();
  const summaryOf = (runId: string): RunCandidateSummary => {
    const existing = byRun.get(runId);
    if (existing) return existing;
    const created: RunCandidateSummary = { total: 0, tiers: { S: 0, A: 0, B: 0, C: 0, notRated: 0 }, shown: [] };
    byRun.set(runId, created);
    return created;
  };

  // The counts use each reel's latest rating. A reel with no rating yet is counted as not rated.
  const counts = await sql<{ run_id: string | null; tier: string | null; n: number | string }>`
    select r.run_id, rt.rating_tier as tier, count(*)::int as n
    from discovered_organic_reels as r
    left join lateral (
      select rating_tier from discovered_reel_ratings
      where reel_id = r.id and organization_id = r.organization_id
      order by rated_at desc
      limit 1
    ) as rt on true
    where r.organization_id = ${organizationId} and r.brand_id = ${brandId}
      and r.run_id in (
        select id from factory_runs
        where organization_id = ${organizationId} and brand_id = ${brandId}
        order by created_at desc
        limit ${RECENT_RUNS_LIMIT}
      )
    group by r.run_id, rt.rating_tier
  `;
  for (const row of counts) {
    if (!row.run_id) continue;
    const summary = summaryOf(row.run_id);
    const n = Number(row.n);
    const tier = tierOf(row.tier);
    summary.total += n;
    if (tier) summary.tiers[tier] += n;
    else summary.tiers.notRated += n;
  }

  const shown = await sql<{
    id: string;
    run_id: string | null;
    permalink: string;
    creator_handle: string;
    views: number | string | null;
    median: number | string | null;
    tier: string | null;
    tier_reason: string | null;
    baseline_reason: string;
  }>`
    select * from (
      select r.id, r.run_id, r.permalink, r.creator_handle, r.creator_baseline_reason as baseline_reason,
        r.creator_median_views::int as median, rt.rating_tier as tier, rt.rating_reason as tier_reason, snap.views as views,
        row_number() over (partition by r.run_id order by r.discovered_at desc, r.id asc) as position
      from discovered_organic_reels as r
      left join lateral (
        select rating_tier, rating_reason from discovered_reel_ratings
        where reel_id = r.id and organization_id = r.organization_id
        order by rated_at desc
        limit 1
      ) as rt on true
      left join lateral (
        select views_count::int as views from discovered_reel_snapshots
        where reel_id = r.id and organization_id = r.organization_id
        order by captured_at desc
        limit 1
      ) as snap on true
      where r.organization_id = ${organizationId} and r.brand_id = ${brandId}
        and r.run_id in (
          select id from factory_runs
          where organization_id = ${organizationId} and brand_id = ${brandId}
          order by created_at desc
          limit ${RECENT_RUNS_LIMIT}
        )
    ) as ranked
    where ranked.position <= ${CANDIDATES_SHOWN_PER_RUN}
    order by ranked.run_id, ranked.position
  `;
  for (const row of shown) {
    if (!row.run_id) continue;
    const tier = tierOf(row.tier);
    const candidate: RunCandidate = {
      id: row.id,
      permalink: row.permalink,
      creatorHandle: row.creator_handle,
      views: numberOrNull(row.views),
      creatorMedianViews: numberOrNull(row.median),
      tier,
      reason: tier ? "" : row.tier_reason || row.baseline_reason || "Not rated yet.",
    };
    summaryOf(row.run_id).shown.push(candidate);
  }
  return byRun;
}
