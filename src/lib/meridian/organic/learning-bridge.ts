/**
 * JEV Organic Content Learning Bridge
 *
 * Ingests first-party and benchmarked organic social content (TikTok, Instagram Reels, YouTube Shorts,
 * Twitter/X, Threads, Facebook, Pinterest, Reddit, LinkedIn) directly into JEV's Bayesian learning engine:
 * 1. Inserts/updates creative_records with identified angle, hook, and format traits.
 * 2. Ingests organic observations (views, 3s hold rate, completion rate, shares, likes, comments).
 * 3. Mines audience comment objections/desires into creative intelligence when comments are present.
 * 4. Triggers applyLearnedPatterns to update Beta posteriors and opportunity rankings.
 *
 * Guarantees JEV learns from what performs organically, not solely paid advertising.
 */

import type { Sql } from "./creators.ts";
import { applyLearnedPatterns } from "../learning/store.ts";
import { classifyComment, type ClassifiedComment } from "./comments.ts";

export type IngestOrganicInput = {
  organizationId: string;
  brandId: string;
  creativeId?: string;
  platform: string;
  sourceUrl?: string;
  title?: string;
  rawText?: string;
  angle: string;
  hookType: string;
  format: string;
  proofType?: string;
  visualStyle?: string;
  metrics: {
    views: number;
    threeSecondViews?: number;
    completionRate?: number; // 0.0 to 1.0
    shares?: number;
    likes?: number;
    comments?: number;
    saves?: number;
  };
  commentsList?: Array<{ text: string; author?: string; likes?: number }>;
};

export async function ingestOrganicContentForLearning(
  sql: Sql,
  input: IngestOrganicInput,
): Promise<{
  creativeId: string;
  observationId: string;
  learnedPatternsCount: number;
  analyzedComments?: ClassifiedComment[];
}> {
  const creativeId = input.creativeId || `cr_org_${globalThis.crypto.randomUUID()}`;
  const now = new Date().toISOString();

  // 1. Ensure creative_records row exists with creative attributes
  await sql`
    insert into creative_records (
      id,
      organization_id,
      brand_id,
      origin,
      source_url,
      title,
      raw_text,
      angle,
      hook_type,
      format,
      proof_type,
      visual_style,
      platform,
      created_by
    ) values (
      ${creativeId},
      ${input.organizationId},
      ${input.brandId},
      'own',
      ${input.sourceUrl || ""},
      ${input.title || ""},
      ${input.rawText || ""},
      ${input.angle.trim().toLowerCase()},
      ${input.hookType.trim().toLowerCase()},
      ${input.format.trim().toLowerCase()},
      ${(input.proofType || "").trim().toLowerCase()},
      ${(input.visualStyle || "").trim().toLowerCase()},
      ${input.platform},
      'system'
    )
    on conflict (id) do update set
      angle = excluded.angle,
      hook_type = excluded.hook_type,
      format = excluded.format,
      proof_type = excluded.proof_type,
      visual_style = excluded.visual_style,
      raw_text = excluded.raw_text
  `;

  // 2. Compute 3s views if missing (heuristic: 45% of views for short-form organic video)
  const views = Math.max(1, input.metrics.views);
  const threeSecondViews = input.metrics.threeSecondViews ?? Math.round(views * 0.45);
  const completionRate = input.metrics.completionRate ?? 0.25;
  const observationId = `org_obs_${globalThis.crypto.randomUUID()}`;

  // 3. Process comment intents if provided
  let analyzedComments: ClassifiedComment[] | undefined;
  let rawMetrics: Record<string, unknown> = {};

  if (input.commentsList && input.commentsList.length > 0) {
    analyzedComments = input.commentsList.map((c, idx) =>
      classifyComment({
        id: `cm_${idx}`,
        text: c.text,
        author: c.author,
        likes: c.likes,
      }),
    );

    const objections = analyzedComments.filter((c) => c.intent === "objection").map((c) => c.text);
    const desires = analyzedComments.filter((c) => c.intent === "desire").map((c) => c.text);
    rawMetrics = {
      commentCount: input.commentsList.length,
      objectionsSummary: objections.slice(0, 5),
      desiresSummary: desires.slice(0, 5),
    };
  }

  // 4. Ensure organic_posts dummy row if table requires foreign key
  const postId = `post_${creativeId}`;
  try {
    await sql`
      insert into organic_posts (
        id, organization_id, brand_id, creative_id, platform, caption, status
      ) values (
        ${postId}, ${input.organizationId}, ${input.brandId}, ${creativeId}, ${input.platform}, ${input.rawText || ""}, 'published'
      )
      on conflict (id) do nothing
    `;
  } catch {
    // organic_posts table may not exist in all environments or is not required
  }

  // 5. Record organic_observations row
  await sql`
    insert into organic_observations (
      id,
      organization_id,
      brand_id,
      organic_post_id,
      creative_id,
      platform,
      views,
      three_second_views,
      completion_rate,
      shares,
      likes,
      comments,
      saves,
      observed_on,
      raw_metrics,
      created_at
    ) values (
      ${observationId},
      ${input.organizationId},
      ${input.brandId},
      ${postId},
      ${creativeId},
      ${input.platform},
      ${views},
      ${threeSecondViews},
      ${completionRate},
      ${input.metrics.shares ?? 0},
      ${input.metrics.likes ?? 0},
      ${input.metrics.comments ?? 0},
      ${input.metrics.saves ?? 0},
      current_date,
      ${JSON.stringify(rawMetrics)},
      ${now}
    )
  `;

  // 6. Trigger JEV learning write-back across brand patterns
  const learnedCount = await applyLearnedPatterns(sql, input.organizationId, input.brandId);

  return {
    creativeId,
    observationId,
    learnedPatternsCount: learnedCount,
    analyzedComments,
  };
}
