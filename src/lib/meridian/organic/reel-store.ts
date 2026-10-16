// Storage for Instagram reel candidates, their checkpoints, their ratings and the Apify requests behind them (B1 and B2).
// Every query carries the organization. An unknown value is written as null.
//
// The tables are migration 0025 as changed by 0090: discovered_organic_reels (one row per reel address per workspace),
// discovered_reel_snapshots (one row per checkpoint: 0, 24 and 72 hours), discovered_reel_ratings (one row per rating, the
// latest is the current one), instagram_volume_requests (every Apify request, written before it is sent).

import { randomUUID } from "node:crypto";
import { withTransaction, type Sql } from "../learning/store.ts";
import { INSTAGRAM_VOLUME_CONFIG, type InstagramVolumeCheckpoint } from "../sources/apify/config.ts";
import { VIEWS_METRIC, type ReelCandidate } from "../sources/apify/instagram-volume.ts";
import type { RatingSnapshot } from "../discovery/snapshot-scheduler.ts";
import type { ReelRatingOutcome } from "../grading/reel-rating.ts";

export type VolumePurpose = "candidates" | "baseline" | "snapshot";

/**
 * Reserves the Apify results one call will ask for, and writes its request row, before the call is sent. Returns the request id when
 * the call may be sent, or null when it would pass the weekly cap: then nothing is written and nothing may be sent.
 *
 * The check and the write run in one transaction under a lock on the workspace row, the lock the engine ledger's reserve takes, so
 * two calls cannot both read the same total and both pass. The total counts every call of the niche in the last seven days, whatever
 * its purpose. A call's whole request is reserved or none is: a partial baseline would change the median it is rated against.
 */
export async function reserveVolumeRequest(
  sql: Sql,
  input: {
    organizationId: string;
    brandId: string;
    runId: string | null;
    niche: string;
    purpose: VolumePurpose;
    actorId: string;
    requestedResults: number;
    weeklyCap: number;
  },
): Promise<string | null> {
  return withTransaction(sql, async (tx) => {
    const locked = await tx<{ id: string }>`select id from organizations where id = ${input.organizationId} for update`;
    if (!locked[0]) throw new Error("The workspace does not exist, so no Apify call was made.");
    const used = await volumeResultsThisWeek(tx, input.organizationId, input.niche);
    if (used + input.requestedResults > input.weeklyCap) return null;

    const id = `ivr_${randomUUID()}`;
    await tx`
      insert into instagram_volume_requests (
        id, organization_id, brand_id, run_id, niche, purpose, actor_id, requested_results, status, reason
      ) values (
        ${id}, ${input.organizationId}, ${input.brandId}, ${input.runId}, ${input.niche}, ${input.purpose},
        ${input.actorId}, ${input.requestedResults}, 'requested', ''
      )
    `;
    return id;
  });
}

/** Records how a request ended. A failed request keeps its requested_results: Apify may still have charged for it. */
export async function settleVolumeRequest(
  sql: Sql,
  input: { organizationId: string; requestId: string; status: "ok" | "failed" | "not_connected"; returnedItems: number | null; reason: string },
): Promise<void> {
  await sql`
    update instagram_volume_requests
    set status = ${input.status}, returned_items = ${input.returnedItems}, reason = ${input.reason.slice(0, 500)}, updated_at = now()
    where id = ${input.requestId} and organization_id = ${input.organizationId}
  `;
}

/**
 * The results this niche has asked Apify for in the last seven days: candidates, creator baselines and snapshots, across every run and
 * every failed request. Each one counts against the weekly cap.
 */
export async function volumeResultsThisWeek(sql: Sql, organizationId: string, niche: string): Promise<number> {
  const rows = await sql<{ total: number }>`
    select coalesce(sum(requested_results), 0)::int as total
    from instagram_volume_requests
    where organization_id = ${organizationId} and niche = ${niche}
      and created_at >= now() - interval '7 days'
  `;
  return Number(rows[0]?.total ?? 0);
}

/** Stores a candidate reel. Returns its id when it is new in this workspace, or null when the address was stored before. */
export async function insertReelCandidate(
  sql: Sql,
  input: {
    organizationId: string;
    brandId: string;
    runId: string | null;
    niche: string;
    actorId: string;
    discoveredAt: string;
    candidate: ReelCandidate;
  },
): Promise<string | null> {
  const id = `reel_${randomUUID()}`;
  const c = input.candidate;
  const rows = await sql<{ id: string }>`
    insert into discovered_organic_reels (
      id, organization_id, brand_id, platform, permalink, external_post_id, creator_handle, niche, caption, hashtags,
      posted_at, discovery_tier, run_id, views_metric, source_actor, discovered_at, created_at
    ) values (
      ${id}, ${input.organizationId}, ${input.brandId}, 'instagram', ${c.permalink}, ${c.externalId}, ${c.creatorHandle},
      ${input.niche}, ${c.caption}, string_to_array(${c.hashtags.join(" ")}, ' '),
      ${c.postedAt}::timestamptz, 'vendor', ${input.runId}, ${VIEWS_METRIC}, ${input.actorId},
      ${input.discoveredAt}::timestamptz, ${input.discoveredAt}::timestamptz
    )
    on conflict (organization_id, permalink) do nothing
    returning id
  `;
  return rows[0]?.id ?? null;
}

/** Stores one checkpoint. A repeated checkpoint for the same reel replaces the earlier reading. */
export async function upsertReelSnapshot(
  sql: Sql,
  input: {
    organizationId: string;
    reelId: string;
    checkpointHours: InstagramVolumeCheckpoint | 0;
    hoursSincePost: number | null;
    views: number | null;
    likes: number | null;
    comments: number | null;
    capturedAt: string;
  },
): Promise<void> {
  await sql`
    insert into discovered_reel_snapshots (
      id, reel_id, organization_id, checkpoint_hours, hours_since_post, views_count, likes_count, comments_count, captured_at
    ) values (
      ${`rsnap_${randomUUID()}`}, ${input.reelId}, ${input.organizationId}, ${input.checkpointHours}, ${input.hoursSincePost},
      ${input.views}, ${input.likes}, ${input.comments}, ${input.capturedAt}::timestamptz
    )
    on conflict (reel_id, checkpoint_hours) do update set
      hours_since_post = excluded.hours_since_post,
      views_count = excluded.views_count,
      likes_count = excluded.likes_count,
      comments_count = excluded.comments_count,
      captured_at = excluded.captured_at
  `;
}

/**
 * The checkpoints of one reel that have both a view count and a comment count, in time order. `hoursSincePost` here is the
 * hours since the first observation (discovery), the origin velocity is measured from.
 */
export async function observedPoints(sql: Sql, organizationId: string, reelId: string): Promise<RatingSnapshot[]> {
  const rows = await sql<{ hours: number | string; views: number | string; comments: number | string }>`
    select
      extract(epoch from (s.captured_at - r.discovered_at)) / 3600.0 as hours,
      s.views_count as views,
      s.comments_count as comments
    from discovered_reel_snapshots as s
    join discovered_organic_reels as r on r.id = s.reel_id and r.organization_id = s.organization_id
    where s.reel_id = ${reelId} and s.organization_id = ${organizationId}
      and s.views_count is not null and s.comments_count is not null
    order by s.captured_at asc
  `;
  return rows.map((row) => ({ hoursSincePost: Number(row.hours), views: Number(row.views), comments: Number(row.comments) }));
}

/**
 * Stores a rating. Every score is null when it was not computed, and intent_score is always null: friend-tag comments are not
 * observed by any source yet, so the intent score cannot be computed honestly.
 */
export async function recordReelRating(
  sql: Sql,
  input: {
    organizationId: string;
    reelId: string;
    checkpointHours: InstagramVolumeCheckpoint | 0;
    outcome: ReelRatingOutcome;
    creatorMedianViews: number | null;
  },
): Promise<void> {
  const result = input.outcome.result;
  const interval = result ? result.confidenceInterval : null;
  await sql`
    insert into discovered_reel_ratings (
      id, reel_id, organization_id, checkpoint_hours, outlier_ratio, shrunk_outlier_score, velocity_score, action_score,
      intent_score, rating_tier, confidence_interval, is_fitted, rating_reason, views_used, creator_median_views, rated_at
    ) values (
      ${`rrat_${randomUUID()}`}, ${input.reelId}, ${input.organizationId}, ${input.checkpointHours},
      ${result ? result.outlierRatio : null}, ${result ? result.shrunkOutlierScore : null},
      ${result ? result.velocityScore : null}, ${result ? result.actionScore : null}, null,
      ${input.outcome.tier}, ${JSON.stringify(interval ?? {})}::jsonb, false, ${input.outcome.reason.slice(0, 500)},
      ${input.outcome.viewsUsed}, ${input.creatorMedianViews}, now()
    )
  `;
}

/**
 * Schedules the +24 h and +72 h checkpoints of a reel through the job queue. The job runs at its time (run_after) and records
 * one checkpoint. A job that already exists for the reel is not added again.
 */
export async function scheduleReelSnapshots(
  sql: Sql,
  input: { organizationId: string; brandId: string; reelId: string; discoveredAt: string },
): Promise<void> {
  const base = Date.parse(input.discoveredAt);
  for (const hours of INSTAGRAM_VOLUME_CONFIG.snapshotHours) {
    const runAfter = new Date(base + hours * 3600 * 1000).toISOString();
    await sql`
      insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, payload, max_attempts, run_after)
      values (
        ${`job_${randomUUID()}`}, ${input.organizationId}, ${input.brandId}, 'organic.reel_snapshot',
        ${`reel-snapshot:${input.reelId}:${hours}h`}, 'queued',
        ${JSON.stringify({ organizationId: input.organizationId, reelId: input.reelId, checkpointHours: hours })}, 3,
        ${runAfter}::timestamptz
      )
      on conflict (organization_id, idempotency_key) do nothing
    `;
  }
}

/** Hours from the post to a later time, or null when the post time is unknown. Rounded to hundredths of an hour. */
export function hoursSincePosted(postedAt: string | null, at: string): number | null {
  if (!postedAt) return null;
  const hours = (Date.parse(at) - Date.parse(postedAt)) / (3600 * 1000);
  return Number.isFinite(hours) ? Math.round(hours * 100) / 100 : null;
}

export type StoredReel = {
  id: string;
  brandId: string;
  niche: string;
  permalink: string;
  externalPostId: string | null;
  creatorHandle: string;
  postedAt: string | null;
  discoveredAt: string;
  creatorMedianViews: number | null;
  creatorBaselineReason: string;
};

export async function loadReel(sql: Sql, organizationId: string, reelId: string): Promise<StoredReel | null> {
  const rows = await sql<{
    id: string;
    brand_id: string;
    niche: string;
    permalink: string;
    external_post_id: string | null;
    creator_handle: string;
    posted_at: string | null;
    discovered_at: string;
    creator_median_views: number | string | null;
    creator_baseline_reason: string;
  }>`
    select id, brand_id, niche, permalink, external_post_id, creator_handle, posted_at, discovered_at,
      creator_median_views, creator_baseline_reason
    from discovered_organic_reels
    where id = ${reelId} and organization_id = ${organizationId}
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    brandId: row.brand_id,
    niche: row.niche,
    permalink: row.permalink,
    externalPostId: row.external_post_id,
    creatorHandle: row.creator_handle,
    postedAt: row.posted_at,
    discoveredAt: row.discovered_at,
    creatorMedianViews: row.creator_median_views === null ? null : Number(row.creator_median_views),
    creatorBaselineReason: row.creator_baseline_reason,
  };
}

/** Records the creator baseline a reel is rated against, or why there is none. */
export async function setReelBaseline(
  sql: Sql,
  input: { organizationId: string; reelId: string; medianViews: number | null; reason: string },
): Promise<void> {
  await sql`
    update discovered_organic_reels
    set creator_median_views = ${input.medianViews}, creator_baseline_reason = ${input.reason.slice(0, 500)}
    where id = ${input.reelId} and organization_id = ${input.organizationId}
  `;
}
