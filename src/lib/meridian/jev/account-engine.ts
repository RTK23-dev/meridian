/**
 * JEV Account Intelligence Engine
 *
 * Elevates JEV from single-variant analysis to account-level portfolio intelligence.
 * Aggregates posts into rolling profiles, identifies top vs. bottom decile creative
 * differentiators, detects whitespace opportunities, and builds 6-beat narrative maps.
 *
 * All operations are tenant-scoped (organizationId, brandId). No data is invented —
 * missing data results in empty/zero values, never hallucinated metrics.
 */

import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { clamp01 } from "../domain.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The 6-beat narrative structure for short-form video decomposition. */
export type NarrativeBeat = "hook" | "problem" | "reveal" | "proof" | "offer" | "cta";

export const NARRATIVE_BEATS: readonly NarrativeBeat[] = [
  "hook", "problem", "reveal", "proof", "offer", "cta",
] as const;

/** Timing boundaries (seconds) for 6-beat detection on a ~30s creative. */
export const BEAT_WINDOWS: Record<NarrativeBeat, { start: number; end: number }> = {
  hook:    { start: 0,  end: 3 },
  problem: { start: 3,  end: 7 },
  reveal:  { start: 7,  end: 15 },
  proof:   { start: 15, end: 25 },
  offer:   { start: 25, end: 30 },
  cta:     { start: 30, end: 35 },
};

/** A single post/reel/short with its engagement metrics for analysis. */
export type ContentItem = {
  id: string;
  platform: string;
  postId: string;
  mediaUrl?: string;
  caption?: string;
  hookType?: string;
  ctaType?: string;
  visualStyle?: string;
  angle?: string;
  /** Engagement (never coerce unknown to zero) */
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  threeSecondRetention: number | null;
  completionRate: number | null;
  /** Audio/visual scores (0-1) */
  hookVisualScore?: number;
  audioEnergyScore?: number;
  speechWpm?: number;
  motionIntensity?: number;
  textDensity?: number;
  colorPalette?: string;
  /** When posted */
  publishedAt?: string;
};

/** Aggregated account-level profile. */
export type AccountProfile = {
  id: string;
  organizationId: string;
  brandId: string;
  platform: string;
  accountHandle: string;
  postCount: number;
  followerCount: number;
  avgEngagementRate: number;
  postingCadenceHours: number;
  brandArchetype: string;
  topHooks: string[];
  saturatedAngles: string[];
  topDecileTraits: Record<string, number>;
  bottomDecileTraits: Record<string, number>;
  rollingWindowDays: number;
  analysisVersion: number;
};

/** A whitespace opportunity — an unsaturated angle with a high expected win probability. */
export type WhitespaceOpportunity = {
  id: string;
  organizationId: string;
  brandId: string;
  category: string;
  unsaturatedAngle: string;
  competitorSaturationScore: number;
  expectedWinProbability: number;
  supportingEvidence: string[];
  status: "proposed" | "accepted" | "rejected" | "explored";
};

// ---------------------------------------------------------------------------
// Core Analysis Functions (Pure — no DB)
// ---------------------------------------------------------------------------

/**
 * Computes the engagement rate for a post: (likes + comments + shares) / views.
 * Preserves null for unknown views or unknown interactions; returns 0 for observed 0.
 */
export function engagementRate(item: ContentItem): number | null {
  if (item.views === null || item.views === undefined) return null;
  if (item.views <= 0) return 0;
  if (item.likes === null && item.comments === null && item.shares === null) return null;
  const interactions = (item.likes ?? 0) + (item.comments ?? 0) + (item.shares ?? 0);
  return clamp01(interactions / item.views);
}

/**
 * Computes the average engagement rate across content items with known metrics.
 * Returns 0 for empty arrays or no observed views.
 */
export function averageEngagementRate(items: readonly ContentItem[]): number {
  if (items.length === 0) return 0;
  const validRates = items
    .map(engagementRate)
    .filter((r): r is number => r !== null);
  if (validRates.length === 0) return 0;
  const total = validRates.reduce((sum, r) => sum + r, 0);
  return total / validRates.length;
}

/**
 * Estimates posting cadence in hours from a chronological set of posts.
 * Returns 0 if fewer than 2 posts have valid timestamps.
 */
export function estimatePostingCadence(items: readonly ContentItem[]): number {
  const timestamps = items
    .filter((item) => item.publishedAt)
    .map((item) => new Date(item.publishedAt!).getTime())
    .filter((ts) => Number.isFinite(ts))
    .sort((a, b) => a - b);

  if (timestamps.length < 2) return 0;

  const gaps: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    const gapMs = timestamps[i] - timestamps[i - 1];
    if (gapMs > 0) gaps.push(gapMs);
  }

  if (gaps.length === 0) return 0;
  const medianGap = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  return medianGap / (1000 * 60 * 60); // ms -> hours
}

/**
 * Splits content items into top-N% and bottom-N% by engagement rate.
 * Only ranks items with observed engagement metrics.
 */
export function decileTraits(
  items: readonly ContentItem[],
  percentile: number = 10,
): { top: Record<string, number>; bottom: Record<string, number> } {
  const itemsWithRate = items
    .map((item) => ({ item, rate: engagementRate(item) }))
    .filter((entry): entry is { item: ContentItem; rate: number } => entry.rate !== null);

  if (itemsWithRate.length < 4) return { top: {}, bottom: {} };

  const sorted = [...itemsWithRate].sort((a, b) => b.rate - a.rate);
  const cutoff = Math.max(1, Math.floor(sorted.length * (percentile / 100)));
  const topSlice = sorted.slice(0, cutoff).map((e) => e.item);
  const bottomSlice = sorted.slice(-cutoff).map((e) => e.item);

  return {
    top: countTraits(topSlice),
    bottom: countTraits(bottomSlice),
  };
}

function countTraits(items: readonly ContentItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    if (item.hookType) counts[`hook:${item.hookType}`] = (counts[`hook:${item.hookType}`] || 0) + 1;
    if (item.ctaType) counts[`cta:${item.ctaType}`] = (counts[`cta:${item.ctaType}`] || 0) + 1;
    if (item.visualStyle) counts[`style:${item.visualStyle}`] = (counts[`style:${item.visualStyle}`] || 0) + 1;
    if (item.angle) counts[`angle:${item.angle}`] = (counts[`angle:${item.angle}`] || 0) + 1;
  }
  return counts;
}

/**
 * Extracts the top-N most frequent hooks from a content set.
 * Returns hook types sorted by frequency descending.
 */
export function extractTopHooks(items: readonly ContentItem[], limit: number = 5): string[] {
  const hooks: Record<string, number> = {};
  for (const item of items) {
    if (item.hookType) hooks[item.hookType] = (hooks[item.hookType] || 0) + 1;
  }
  return Object.entries(hooks)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([hook]) => hook);
}

/**
 * Identifies saturated angles — those used by 30%+ of content.
 */
export function findSaturatedAngles(
  items: readonly ContentItem[],
  threshold: number = 0.3,
): string[] {
  if (items.length === 0) return [];
  const angles: Record<string, number> = {};
  for (const item of items) {
    if (item.angle) angles[item.angle] = (angles[item.angle] || 0) + 1;
  }
  const cutoff = items.length * threshold;
  return Object.entries(angles)
    .filter(([, count]) => count >= cutoff)
    .sort((a, b) => b[1] - a[1])
    .map(([angle]) => angle);
}

/**
 * Builds a complete account profile from a set of content items.
 * This is the primary aggregation function.
 */
export function analyzeAccountPortfolio(
  organizationId: string,
  brandId: string,
  platform: string,
  accountHandle: string,
  items: readonly ContentItem[],
  opts?: { followerCount?: number; rollingWindowDays?: number },
): AccountProfile {
  const windowDays = opts?.rollingWindowDays ?? 30;

  const { top, bottom } = decileTraits(items);
  const topHooks = extractTopHooks(items);
  const saturated = findSaturatedAngles(items);

  // Determine brand archetype from dominant visual style + hook combo
  const archetype = determineBrandArchetype(items);

  return {
    id: randomUUID(),
    organizationId,
    brandId,
    platform,
    accountHandle,
    postCount: items.length,
    followerCount: opts?.followerCount ?? 0,
    avgEngagementRate: averageEngagementRate(items),
    postingCadenceHours: estimatePostingCadence(items),
    brandArchetype: archetype,
    topHooks,
    saturatedAngles: saturated,
    topDecileTraits: top,
    bottomDecileTraits: bottom,
    rollingWindowDays: windowDays,
    analysisVersion: 1,
  };
}

/**
 * Determines a brand archetype label from the dominant patterns.
 * Returns a descriptor like "ugc_authentic", "polished_studio", "meme_reactive", etc.
 */
function determineBrandArchetype(items: readonly ContentItem[]): string {
  if (items.length === 0) return "unknown";

  const styles: Record<string, number> = {};
  for (const item of items) {
    const style = item.visualStyle || "mixed";
    styles[style] = (styles[style] || 0) + 1;
  }

  const dominant = Object.entries(styles).sort((a, b) => b[1] - a[1])[0];
  if (!dominant) return "unknown";

  const ratio = dominant[1] / items.length;
  if (ratio < 0.3) return "mixed_eclectic";
  return dominant[0];
}

// ---------------------------------------------------------------------------
// Whitespace Detection
// ---------------------------------------------------------------------------

/**
 * Detects whitespace opportunities by comparing a brand's own angles against
 * competitor profiles. Returns angles that competitors are NOT heavily using
 * but show high engagement when they do appear.
 */
export function detectWhitespaceOpportunities(
  organizationId: string,
  brandId: string,
  ownItems: readonly ContentItem[],
  competitorItems: readonly ContentItem[],
  opts?: { minCompetitorPosts?: number; maxOpportunities?: number },
): WhitespaceOpportunity[] {
  const minPosts = opts?.minCompetitorPosts ?? 5;
  const maxOps = opts?.maxOpportunities ?? 10;

  if (competitorItems.length < minPosts) return [];

  // Collect all angles from competitors and their engagement rates
  const competitorAngleStats = new Map<string, { count: number; totalEngagement: number }>();
  for (const item of competitorItems) {
    if (!item.angle) continue;
    const existing = competitorAngleStats.get(item.angle) || { count: 0, totalEngagement: 0 };
    existing.count += 1;
    const rate = engagementRate(item);
    if (rate !== null) {
      existing.totalEngagement += rate;
    }
    competitorAngleStats.set(item.angle, existing);
  }

  // Collect all unique angles from both own + competitor content
  const allAngles = new Set<string>();
  for (const item of [...ownItems, ...competitorItems]) {
    if (item.angle) allAngles.add(item.angle);
  }

  // Own angle performance
  const ownAngleEngagement = new Map<string, number[]>();
  for (const item of ownItems) {
    if (!item.angle) continue;
    const rates = ownAngleEngagement.get(item.angle) || [];
    const rate = engagementRate(item);
    if (rate !== null) {
      rates.push(rate);
    }
    ownAngleEngagement.set(item.angle, rates);
  }

  const opportunities: WhitespaceOpportunity[] = [];

  for (const angle of allAngles) {
    const compStats = competitorAngleStats.get(angle);
    const saturationScore = compStats
      ? compStats.count / competitorItems.length
      : 0;

    // We want LOW saturation (competitors aren't doing it much)
    if (saturationScore > 0.25) continue;

    // Estimate expected win probability from own performance or competitor performance
    let expectedWin = 0.5; // Bayesian neutral prior
    const ownRates = ownAngleEngagement.get(angle);
    if (ownRates && ownRates.length > 0) {
      const avgOwn = ownRates.reduce((a, b) => a + b, 0) / ownRates.length;
      const overallAvg = averageEngagementRate(ownItems);
      // If this angle performs above our average, boost expected win
      expectedWin = overallAvg > 0 ? clamp01(0.5 + (avgOwn - overallAvg) / overallAvg * 0.3) : 0.5;
    } else if (compStats && compStats.count > 0) {
      // If competitors show it does well even with low usage, that's signal
      const avgComp = compStats.totalEngagement / compStats.count;
      const overallComp = averageEngagementRate(competitorItems);
      expectedWin = overallComp > 0 ? clamp01(0.5 + (avgComp - overallComp) / overallComp * 0.3) : 0.5;
    }

    const evidence: string[] = [];
    if (compStats) {
      evidence.push(`Competitor usage: ${compStats.count}/${competitorItems.length} posts (${(saturationScore * 100).toFixed(1)}%)`);
    } else {
      evidence.push("Angle not found in competitor content");
    }
    if (ownRates) {
      evidence.push(`Own usage: ${ownRates.length} posts, avg engagement ${(ownRates.reduce((a, b) => a + b, 0) / ownRates.length * 100).toFixed(2)}%`);
    }

    opportunities.push({
      id: randomUUID(),
      organizationId,
      brandId,
      category: "angle",
      unsaturatedAngle: angle,
      competitorSaturationScore: clamp01(saturationScore),
      expectedWinProbability: expectedWin,
      supportingEvidence: evidence,
      status: "proposed",
    });
  }

  // Sort by expected win probability (highest first), then lowest saturation
  return opportunities
    .sort((a, b) => b.expectedWinProbability - a.expectedWinProbability || a.competitorSaturationScore - b.competitorSaturationScore)
    .slice(0, maxOps);
}

// ---------------------------------------------------------------------------
// Database Persistence
// ---------------------------------------------------------------------------

/**
 * Stores an account profile. Upserts by (organization_id, brand_id, platform, account_handle).
 */
export async function storeAccountProfile(
  sql: Sql,
  profile: AccountProfile,
): Promise<string> {
  const id = profile.id || randomUUID();
  await sql`
    insert into jev_account_profiles (
      id, organization_id, brand_id, platform, account_handle,
      post_count, follower_count, avg_engagement_rate, posting_cadence_hours,
      brand_archetype, top_hooks, saturated_angles,
      top_decile_traits, bottom_decile_traits,
      rolling_window_days, analysis_version, updated_at
    ) values (
      ${id}, ${profile.organizationId}, ${profile.brandId}, ${profile.platform}, ${profile.accountHandle},
      ${profile.postCount}, ${profile.followerCount}, ${profile.avgEngagementRate}, ${profile.postingCadenceHours},
      ${profile.brandArchetype}, ${JSON.stringify(profile.topHooks)}, ${JSON.stringify(profile.saturatedAngles)},
      ${JSON.stringify(profile.topDecileTraits)}, ${JSON.stringify(profile.bottomDecileTraits)},
      ${profile.rollingWindowDays}, ${profile.analysisVersion}, now()
    )
  `;
  return id;
}

/**
 * Retrieves stored account profiles for a brand. Tenant-scoped.
 */
export async function getAccountProfiles(
  sql: Sql,
  organizationId: string,
  brandId: string,
  platform?: string,
): Promise<AccountProfile[]> {
  const rows = platform
    ? await sql`
        select * from jev_account_profiles
        where organization_id = ${organizationId} and brand_id = ${brandId} and platform = ${platform}
        order by updated_at desc
      `
    : await sql`
        select * from jev_account_profiles
        where organization_id = ${organizationId} and brand_id = ${brandId}
        order by updated_at desc
      `;

  return (rows || []).map((r: any) => ({
    id: r.id,
    organizationId: r.organization_id,
    brandId: r.brand_id,
    platform: r.platform,
    accountHandle: r.account_handle || "",
    postCount: Number(r.post_count) || 0,
    followerCount: Number(r.follower_count) || 0,
    avgEngagementRate: Number(r.avg_engagement_rate) || 0,
    postingCadenceHours: Number(r.posting_cadence_hours) || 0,
    brandArchetype: r.brand_archetype || "",
    topHooks: parseJsonArray(r.top_hooks),
    saturatedAngles: parseJsonArray(r.saturated_angles),
    topDecileTraits: parseJsonRecord(r.top_decile_traits),
    bottomDecileTraits: parseJsonRecord(r.bottom_decile_traits),
    rollingWindowDays: Number(r.rolling_window_days) || 30,
    analysisVersion: Number(r.analysis_version) || 1,
  }));
}

/**
 * Stores a whitespace opportunity. Tenant-scoped.
 */
export async function storeWhitespaceOpportunity(
  sql: Sql,
  opp: WhitespaceOpportunity,
): Promise<string> {
  const id = opp.id || randomUUID();
  await sql`
    insert into jev_whitespace_opportunities (
      id, organization_id, brand_id, category, unsaturated_angle,
      competitor_saturation_score, expected_win_probability,
      supporting_evidence, status
    ) values (
      ${id}, ${opp.organizationId}, ${opp.brandId}, ${opp.category}, ${opp.unsaturatedAngle},
      ${opp.competitorSaturationScore}, ${opp.expectedWinProbability},
      ${JSON.stringify(opp.supportingEvidence)}, ${opp.status}
    )
  `;
  return id;
}

/**
 * Retrieves whitespace opportunities for a brand. Tenant-scoped.
 */
export async function getWhitespaceOpportunities(
  sql: Sql,
  organizationId: string,
  brandId: string,
  status?: string,
): Promise<WhitespaceOpportunity[]> {
  const rows = status
    ? await sql`
        select * from jev_whitespace_opportunities
        where organization_id = ${organizationId} and brand_id = ${brandId} and status = ${status}
        order by expected_win_probability desc
      `
    : await sql`
        select * from jev_whitespace_opportunities
        where organization_id = ${organizationId} and brand_id = ${brandId}
        order by expected_win_probability desc
      `;

  return (rows || []).map((r: any) => ({
    id: r.id,
    organizationId: r.organization_id,
    brandId: r.brand_id,
    category: r.category || "",
    unsaturatedAngle: r.unsaturated_angle || "",
    competitorSaturationScore: Number(r.competitor_saturation_score) || 0,
    expectedWinProbability: Number(r.expected_win_probability) || 0,
    supportingEvidence: parseJsonArray(r.supporting_evidence),
    status: r.status || "proposed",
  }));
}

export type ContentAnalysis = {
  id?: string;
  organizationId: string;
  brandId: string;
  accountId?: string;
  postId: string;
  mediaSha256?: string;
  hookVisualScore?: number;
  audioEnergyScore?: number;
  speechWpm?: number;
  narrativeBeats?: Record<NarrativeBeat, number>;
  detectedObjections?: string[];
  topCommentsSummary?: string;
  visualStyle?: string;
  colorPalette?: string;
  motionIntensity?: number;
  textDensity?: number;
  hookType?: string;
  ctaType?: string;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  threeSecondRetention?: number | null;
  completionRate?: number | null;
  createdAt?: string;
};

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Stores a multimodal content analysis record. Tenant-scoped.
 */
export async function storeContentAnalysis(
  sql: Sql,
  item: ContentAnalysis,
): Promise<string> {
  const id = item.id || randomUUID();
  await sql`
    insert into jev_content_analyses (
      id, organization_id, brand_id, account_id, post_id,
      media_sha256, hook_visual_score, audio_energy_score, speech_wpm,
      narrative_beats, detected_objections, top_comments_summary,
      visual_style, color_palette, motion_intensity, text_density,
      hook_type, cta_type, engagement_views, engagement_likes,
      engagement_comments, engagement_shares, three_second_retention, completion_rate
    ) values (
      ${id}, ${item.organizationId}, ${item.brandId}, ${item.accountId ?? null}, ${item.postId},
      ${item.mediaSha256 ?? ""}, ${item.hookVisualScore ?? 0}, ${item.audioEnergyScore ?? 0}, ${item.speechWpm ?? 0},
      ${JSON.stringify(item.narrativeBeats ?? {})}, ${JSON.stringify(item.detectedObjections ?? [])}, ${item.topCommentsSummary ?? ""},
      ${item.visualStyle ?? ""}, ${item.colorPalette ?? ""}, ${item.motionIntensity ?? 0}, ${item.textDensity ?? 0},
      ${item.hookType ?? ""}, ${item.ctaType ?? ""},
      ${item.views ?? null}, ${item.likes ?? null},
      ${item.comments ?? null}, ${item.shares ?? null},
      ${item.threeSecondRetention ?? null}, ${item.completionRate ?? null}
    )
  `;
  return id;
}

/**
 * Retrieves content analyses for a brand. Tenant-scoped.
 */
export async function getContentAnalyses(
  sql: Sql,
  organizationId: string,
  brandId: string,
  opts?: { accountId?: string; limit?: number },
): Promise<ContentAnalysis[]> {
  const limit = opts?.limit ?? 50;
  const rows = opts?.accountId
    ? await sql`
        select * from jev_content_analyses
        where organization_id = ${organizationId} and brand_id = ${brandId} and account_id = ${opts.accountId}
        order by created_at desc
        limit ${limit}
      `
    : await sql`
        select * from jev_content_analyses
        where organization_id = ${organizationId} and brand_id = ${brandId}
        order by created_at desc
        limit ${limit}
      `;

  return (rows || []).map((r: any) => ({
    id: r.id,
    organizationId: r.organization_id,
    brandId: r.brand_id,
    accountId: r.account_id ?? undefined,
    postId: r.post_id || "",
    mediaSha256: r.media_sha256 || "",
    hookVisualScore: optionalNumber(r.hook_visual_score) ?? 0,
    audioEnergyScore: optionalNumber(r.audio_energy_score) ?? 0,
    speechWpm: optionalNumber(r.speech_wpm) ?? 0,
    narrativeBeats: parseJsonRecord(r.narrative_beats) as Record<NarrativeBeat, number>,
    detectedObjections: parseJsonArray(r.detected_objections),
    topCommentsSummary: r.top_comments_summary || "",
    visualStyle: r.visual_style || "",
    colorPalette: r.color_palette || "",
    motionIntensity: optionalNumber(r.motion_intensity) ?? 0,
    textDensity: optionalNumber(r.text_density) ?? 0,
    hookType: r.hook_type || "",
    ctaType: r.cta_type || "",
    views: optionalNumber(r.engagement_views),
    likes: optionalNumber(r.engagement_likes),
    comments: optionalNumber(r.engagement_comments),
    shares: optionalNumber(r.engagement_shares),
    threeSecondRetention: optionalNumber(r.three_second_retention),
    completionRate: optionalNumber(r.completion_rate),
    createdAt: r.created_at ? String(r.created_at) : undefined,
  }));
}

/** Convenience aliases */
export const saveAccountProfile = storeAccountProfile;
export const saveContentAnalysis = storeContentAnalysis;
export const saveWhitespaceOpportunity = storeWhitespaceOpportunity;

export async function getAccountProfile(
  sql: Sql,
  organizationId: string,
  brandId: string,
  platform?: string,
): Promise<AccountProfile | null> {
  const profiles = await getAccountProfiles(sql, organizationId, brandId, platform);
  return profiles[0] ?? null;
}

// ---------------------------------------------------------------------------
// JSON Helpers
// ---------------------------------------------------------------------------

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* return empty */ }
  }
  return [];
}

function parseJsonRecord(value: unknown): Record<string, number> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    }
    return out;
  }
  if (typeof value === "string") {
    try {
      return parseJsonRecord(JSON.parse(value));
    } catch { /* return empty */ }
  }
  return {};
}
