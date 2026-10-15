/**
 * Creator Snapshots: the baseline a creator's reels are rated against (B2).
 *
 * One row is one measurement of a creator's normal reach: the median views of the creator's last reels (creator-normal).
 * The columns are the ones migration 0026 defines (followers_count, median_views, median_likes, median_comments), plus the
 * organization, the number of reels the median came from, and why a median is missing (0090). An unknown value is null.
 */

import type { Sql } from "../learning/store.ts";

export type CreatorBaselineStatus = "measured" | "insufficient" | "failed";

export type CreatorSnapshot = {
  id: string;
  creatorId: string;
  organizationId: string;
  followersCount: number | null;
  medianViews: number | null;
  medianLikes: number | null;
  medianComments: number | null;
  reelSampleSize: number | null;
  baselineStatus: CreatorBaselineStatus | null;
  baselineReason: string;
  capturedAt: string;
};

export type RecordCreatorSnapshotInput = {
  creatorId: string;
  organizationId: string;
  followersCount?: number | null;
  medianViews?: number | null;
  medianLikes?: number | null;
  medianComments?: number | null;
  reelSampleSize?: number | null;
  baselineStatus?: CreatorBaselineStatus | null;
  baselineReason?: string;
};

export async function recordCreatorSnapshot(sql: Sql, input: RecordCreatorSnapshotInput): Promise<CreatorSnapshot> {
  const id = `crsnap_${globalThis.crypto.randomUUID()}`;
  const rows = await sql<CreatorSnapshot>`
    insert into creator_snapshots (
      id, creator_id, organization_id, followers_count, median_views, median_likes, median_comments,
      reel_sample_size, baseline_status, baseline_reason, captured_at
    ) values (
      ${id},
      ${input.creatorId},
      ${input.organizationId},
      ${input.followersCount ?? null},
      ${input.medianViews ?? null},
      ${input.medianLikes ?? null},
      ${input.medianComments ?? null},
      ${input.reelSampleSize ?? null},
      ${input.baselineStatus ?? null},
      ${input.baselineReason ?? ""},
      now()
    )
    returning
      id,
      creator_id as "creatorId",
      organization_id as "organizationId",
      followers_count as "followersCount",
      median_views as "medianViews",
      median_likes as "medianLikes",
      median_comments as "medianComments",
      reel_sample_size as "reelSampleSize",
      baseline_status as "baselineStatus",
      baseline_reason as "baselineReason",
      captured_at as "capturedAt"
  `;
  const result = rows[0];
  if (!result) throw new Error("Failed to insert creator snapshot");
  return result;
}

export async function getLatestCreatorSnapshot(sql: Sql, organizationId: string, creatorId: string): Promise<CreatorSnapshot | null> {
  const rows = await sql<CreatorSnapshot>`
    select
      id,
      creator_id as "creatorId",
      organization_id as "organizationId",
      followers_count as "followersCount",
      median_views as "medianViews",
      median_likes as "medianLikes",
      median_comments as "medianComments",
      reel_sample_size as "reelSampleSize",
      baseline_status as "baselineStatus",
      baseline_reason as "baselineReason",
      captured_at as "capturedAt"
    from creator_snapshots
    where organization_id = ${organizationId} and creator_id = ${creatorId}
    order by captured_at desc
    limit 1
  `;
  return rows[0] ?? null;
}

/**
 * The latest baseline that may be reused: one that was measured, or found insufficient, within the last `days` days. A baseline
 * that failed to be fetched is not reused, so the next run asks again.
 */
export async function reusableBaseline(
  sql: Sql,
  organizationId: string,
  creatorId: string,
  days: number,
): Promise<CreatorSnapshot | null> {
  const rows = await sql<CreatorSnapshot>`
    select
      id,
      creator_id as "creatorId",
      organization_id as "organizationId",
      followers_count as "followersCount",
      median_views as "medianViews",
      median_likes as "medianLikes",
      median_comments as "medianComments",
      reel_sample_size as "reelSampleSize",
      baseline_status as "baselineStatus",
      baseline_reason as "baselineReason",
      captured_at as "capturedAt"
    from creator_snapshots
    where organization_id = ${organizationId} and creator_id = ${creatorId}
      and baseline_status in ('measured', 'insufficient')
      and captured_at >= now() - (${days}::int * interval '1 day')
    order by captured_at desc
    limit 1
  `;
  return rows[0] ?? null;
}
