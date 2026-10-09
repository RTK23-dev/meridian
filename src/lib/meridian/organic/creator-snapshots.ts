/**
 * Creator Snapshots Time Series
 *
 * Records historical creator metrics to establish individual creator-normal baselines.
 */

import type { Sql } from "../learning/store.ts";

export type CreatorSnapshot = {
  id: string;
  creatorId: string;
  organizationId: string;
  followers: number;
  viewsMedian: number;
  likesMedian: number;
  commentsMedian: number;
  metrics: Record<string, unknown>;
  capturedAt: string;
};

export async function recordCreatorSnapshot(
  sql: Sql,
  input: {
    creatorId: string;
    organizationId: string;
    followers?: number;
    viewsMedian?: number;
    likesMedian?: number;
    commentsMedian?: number;
    metrics?: Record<string, unknown>;
  },
): Promise<CreatorSnapshot> {
  const id = `crsnap_${globalThis.crypto.randomUUID()}`;
  const rows = await sql<CreatorSnapshot>`
    insert into creator_snapshots (
      id, creator_id, organization_id, followers, views_median, likes_median, comments_median, metrics, captured_at
    ) values (
      ${id},
      ${input.creatorId},
      ${input.organizationId},
      ${input.followers ?? null},
      ${input.viewsMedian ?? null},
      ${input.likesMedian ?? null},
      ${input.commentsMedian ?? null},
      ${JSON.stringify(input.metrics ?? {})}::jsonb,
      now()
    )
    returning
      id,
      creator_id as "creatorId",
      organization_id as "organizationId",
      followers,
      views_median as "viewsMedian",
      likes_median as "likesMedian",
      comments_median as "commentsMedian",
      metrics,
      captured_at as "capturedAt"
  `;
  const result = rows[0];
  if (!result) throw new Error("Failed to insert creator snapshot");
  return result;
}

export async function getLatestCreatorSnapshot(
  sql: Sql,
  organizationId: string,
  creatorId: string,
): Promise<CreatorSnapshot | null> {
  const rows = await sql<CreatorSnapshot>`
    select
      id,
      creator_id as "creatorId",
      organization_id as "organizationId",
      followers,
      views_median as "viewsMedian",
      likes_median as "likesMedian",
      comments_median as "commentsMedian",
      metrics,
      captured_at as "capturedAt"
    from creator_snapshots
    where organization_id = ${organizationId} and creator_id = ${creatorId}
    order by captured_at desc
    limit 1
  `;
  return rows[0] ?? null;
}
