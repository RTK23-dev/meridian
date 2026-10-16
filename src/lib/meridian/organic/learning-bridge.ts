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
 *
 * The organic_posts row this writes is marked `published`, so it is a receipt. A receipt needs the platform's own post id: the
 * ingest refuses to run without one, and a failed write stops the ingest instead of being swallowed. The writes run in one
 * transaction, so a failed post row leaves no creative or observation behind.
 */

import type { Sql } from "./creators.ts";
import { applyLearnedPatterns, withTransaction } from "../learning/store.ts";
import { classifyComment, type ClassifiedComment } from "./comments.ts";

export type IngestOrganicInput = {
  organizationId: string;
  brandId: string;
  creativeId?: string;
  platform: string;
  /**
   * The platform's own id for the post. Required: the organic_posts row is written as published, and a published row without the
   * platform's id is not a receipt (AGENTS.md rule 1). The ingest throws when it is missing or blank, before anything is written.
   */
  externalPostId?: string;
  sourceUrl?: string;
  title?: string;
  rawText?: string;
  angle: string;
  hookType: string;
  format: string;
  proofType?: string;
  visualStyle?: string;
  /** Unknown metrics are null or omitted. They are stored as unknown, never as zero. */
  metrics: {
    views?: number | null;
    threeSecondViews?: number | null;
    completionRate?: number | null; // 0.0 to 1.0
    shares?: number | null;
    likes?: number | null;
    comments?: number | null;
    saves?: number | null;
  };
  commentsList?: Array<{ text: string; author?: string; likes?: number }>;
};

export function extractOrganicMetrics(metrics: {
  views?: number | null;
  threeSecondViews?: number | null;
  completionRate?: number | null;
  shares?: number | null;
  likes?: number | null;
  comments?: number | null;
  saves?: number | null;
}) {
  return {
    views: metrics.views ?? null,
    threeSecondViews: metrics.threeSecondViews ?? null,
    completionRate: metrics.completionRate ?? null,
    shares: metrics.shares ?? null,
    likes: metrics.likes ?? null,
    comments: metrics.comments ?? null,
    saves: metrics.saves ?? null,
  };
}

export async function ingestOrganicContentForLearning(
  sql: Sql,
  input: IngestOrganicInput,
): Promise<{
  creativeId: string;
  observationId: string;
  learnedPatternsCount: number;
  analyzedComments?: ClassifiedComment[];
}> {
  // Refused before any write: a published row needs the platform's own post id.
  const externalPostId = (input.externalPostId ?? "").trim();
  if (!externalPostId) {
    throw new Error("Organic learning needs the platform's own post id, so no published post row was written. Nothing was stored.");
  }

  const creativeId = input.creativeId || `cr_org_${globalThis.crypto.randomUUID()}`;
  const now = new Date().toISOString();

  // Truthful metric extraction without synthetic fallback fabrication
  const extracted = extractOrganicMetrics(input.metrics);
  const views = extracted.views;
  const threeSecondViews = extracted.threeSecondViews;
  const completionRate = extracted.completionRate;
  const observationId = `org_obs_${globalThis.crypto.randomUUID()}`;

  // Process comment intents if provided
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

  const postId = `post_${creativeId}`;

  await withTransaction(sql, async (tx) => {
    // 1. Ensure creative_records row exists with creative attributes
    await tx`
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

    // 2. The organic_posts row is the post's receipt, with the platform's own id. A failed write is not swallowed: the observation
    //    below needs this row, so the error stops the ingest and the transaction rolls back.
    await tx`
      insert into organic_posts (
        id, organization_id, brand_id, creative_id, platform, caption, status, external_id
      ) values (
        ${postId}, ${input.organizationId}, ${input.brandId}, ${creativeId}, ${input.platform}, ${input.rawText || ""}, 'published',
        ${externalPostId}
      )
      on conflict (id) do nothing
    `;

    // 3. Record organic_observations row
    await tx`
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
        ${extracted.shares},
        ${extracted.likes},
        ${extracted.comments},
        ${extracted.saves},
        current_date,
        ${JSON.stringify(rawMetrics)},
        ${now}
      )
    `;
  });

  // Trigger JEV learning write-back across brand patterns
  const learnedCount = await applyLearnedPatterns(sql, input.organizationId, input.brandId);

  return {
    creativeId,
    observationId,
    learnedPatternsCount: learnedCount,
    analyzedComments,
  };
}
