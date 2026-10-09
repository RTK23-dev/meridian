/**
 * Creator Profile Management
 *
 * Tracks organic creators across discovery platforms (Instagram, TikTok, YouTube).
 */

import type { Sql } from "../learning/store.ts";
export type { Sql };

export type CreatorProfile = {
  id: string;
  organizationId: string;
  platform: string;
  handle: string;
  displayName?: string | null;
  niche?: string | null;
  followerCount: number;
  engagementRate: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export async function upsertCreatorProfile(
  sql: Sql,
  input: {
    organizationId: string;
    platform: string;
    handle: string;
    displayName?: string;
    niche?: string;
    followerCount?: number;
    engagementRate?: number;
    metadata?: Record<string, unknown>;
  },
): Promise<CreatorProfile> {
  const id = `cr_${input.platform}_${input.handle.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
  const rows = await sql<CreatorProfile>`
    insert into creators (
      id, organization_id, platform, handle, display_name, niche, follower_count, engagement_rate, metadata, updated_at
    ) values (
      ${id},
      ${input.organizationId},
      ${input.platform},
      ${input.handle},
      ${input.displayName ?? null},
      ${input.niche ?? null},
      ${input.followerCount ?? 0},
      ${input.engagementRate ?? 0},
      ${JSON.stringify(input.metadata ?? {})}::jsonb,
      now()
    )
    on conflict (organization_id, platform, handle) do update set
      display_name = coalesce(excluded.display_name, creators.display_name),
      niche = coalesce(excluded.niche, creators.niche),
      follower_count = excluded.follower_count,
      engagement_rate = excluded.engagement_rate,
      metadata = excluded.metadata,
      updated_at = now()
    returning
      id,
      organization_id as "organizationId",
      platform,
      handle,
      display_name as "displayName",
      niche,
      follower_count as "followerCount",
      engagement_rate as "engagementRate",
      metadata,
      created_at as "createdAt",
      updated_at as "updatedAt"
  `;
  const result = rows[0];
  if (!result) throw new Error("Failed to upsert creator profile");
  return result;
}

export async function getCreatorProfile(
  sql: Sql,
  organizationId: string,
  creatorId: string,
): Promise<CreatorProfile | null> {
  const rows = await sql<CreatorProfile>`
    select
      id,
      organization_id as "organizationId",
      platform,
      handle,
      display_name as "displayName",
      niche,
      follower_count as "followerCount",
      engagement_rate as "engagementRate",
      metadata,
      created_at as "createdAt",
      updated_at as "updatedAt"
    from creators
    where organization_id = ${organizationId} and id = ${creatorId}
    limit 1
  `;
  return rows[0] ?? null;
}

export async function listCreatorsByNiche(
  sql: Sql,
  organizationId: string,
  niche: string,
  limit = 50,
): Promise<CreatorProfile[]> {
  const rows = await sql<CreatorProfile>`
    select
      id,
      organization_id as "organizationId",
      platform,
      handle,
      display_name as "displayName",
      niche,
      follower_count as "followerCount",
      engagement_rate as "engagementRate",
      metadata,
      created_at as "createdAt",
      updated_at as "updatedAt"
    from creators
    where organization_id = ${organizationId} and niche = ${niche}
    order by follower_count desc
    limit ${limit}
  `;
  return rows;
}
