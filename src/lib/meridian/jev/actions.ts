import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { requireBrandAccess } from "../distribution/service.ts";
import {
  analyzeAccountPortfolio,
  detectWhitespaceOpportunities,
  getAccountProfile,
  getContentAnalyses,
  getWhitespaceOpportunities,
  saveAccountProfile,
  saveContentAnalysis,
  saveWhitespaceOpportunity,
  type ContentItem,
  type NarrativeBeat,
} from "./account-engine.ts";
import { evaluateMultimodalCreative } from "./multimodal-scorer.ts";

function clip(value: unknown, maxLen = 120): string {
  return typeof value === "string" ? value.trim().slice(0, maxLen) : "";
}

/**
 * Retrieves the JEV account profile, recent content analyses, and whitespace
 * opportunities for a given brand and platform. Viewer role required.
 */
export const getJevAccountIntelligenceFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const brandId = clip(body.brandId);
    const platform = typeof body.platform === "string" ? clip(body.platform) : "instagram";
    if (!brandId) throw new Error("Choose a brand.");
    return { brandId, platform };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrandAccess(sql, context.userId, data.brandId, "viewer");
    const [profile, analyses, whitespace] = await Promise.all([
      getAccountProfile(sql, access.organizationId, data.brandId, data.platform),
      getContentAnalyses(sql, access.organizationId, data.brandId, { limit: 20 }),
      getWhitespaceOpportunities(sql, access.organizationId, data.brandId),
    ]);

    return {
      role: access.role,
      profile,
      analyses,
      whitespace,
    };
  });

/**
 * Updates the triage status of a whitespace opportunity ('proposed' | 'accepted' | 'rejected' | 'explored').
 * Member role required.
 */
export const updateWhitespaceStatusFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const brandId = clip(body.brandId);
    const opportunityId = clip(body.opportunityId);
    const status = clip(body.status);
    const validStatuses = ["proposed", "accepted", "rejected", "explored"];

    if (!brandId) throw new Error("Choose a brand.");
    if (!opportunityId) throw new Error("Missing opportunity ID.");
    if (!validStatuses.includes(status)) throw new Error("Invalid status.");

    return {
      brandId,
      opportunityId,
      status: status as "proposed" | "accepted" | "rejected" | "explored",
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrandAccess(sql, context.userId, data.brandId, "member");

    await sql`
      update jev_whitespace_opportunities
      set status = ${data.status}
      where id = ${data.opportunityId}
        and organization_id = ${access.organizationId}
        and brand_id = ${data.brandId}
    `;

    return { ok: true, status: data.status };
  });

/**
 * Runs account portfolio analysis on supplied content items, executes multimodal scoring,
 * updates the account profile, and generates fresh whitespace opportunities.
 * Member role required.
 */
export const runAccountIntelligenceAnalysisFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const brandId = clip(body.brandId);
    const platform = clip(body.platform) || "instagram";
    const accountHandle = clip(body.accountHandle);
    const rawItems = Array.isArray(body.items) ? body.items : [];

    if (!brandId) throw new Error("Choose a brand.");

    const items: ContentItem[] = rawItems.map((r: any, idx: number) => ({
      id: clip(r.id) || `post-${idx}`,
      platform: clip(r.platform) || platform,
      postId: clip(r.postId) || `ext-${idx}`,
      mediaUrl: typeof r.mediaUrl === "string" ? r.mediaUrl : undefined,
      caption: typeof r.caption === "string" ? r.caption.slice(0, 1000) : undefined,
      hookType: typeof r.hookType === "string" ? clip(r.hookType) : undefined,
      ctaType: typeof r.ctaType === "string" ? clip(r.ctaType) : undefined,
      visualStyle: typeof r.visualStyle === "string" ? clip(r.visualStyle) : undefined,
      angle: typeof r.angle === "string" ? clip(r.angle) : undefined,
      views: Number(r.views) || 0,
      likes: Number(r.likes) || 0,
      comments: Number(r.comments) || 0,
      shares: Number(r.shares) || 0,
      threeSecondRetention: Number(r.threeSecondRetention) || 0,
      completionRate: Number(r.completionRate) || 0,
      motionIntensity: Number(r.motionIntensity) || 0,
      textDensity: Number(r.textDensity) || 0,
      speechWpm: Number(r.speechWpm) || 0,
      audioEnergyScore: Number(r.audioEnergyScore) || 0,
      publishedAt: typeof r.publishedAt === "string" ? r.publishedAt : undefined,
    }));

    return { brandId, platform, accountHandle, items };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrandAccess(sql, context.userId, data.brandId, "member");

    // 1. Analyze portfolio
    const profile = analyzeAccountPortfolio(
      access.organizationId,
      data.brandId,
      data.platform,
      data.accountHandle,
      data.items,
    );

    // 2. Persist profile
    await saveAccountProfile(sql, profile);

    // 3. Score multimodal creative and save individual content analyses
    for (const item of data.items) {
      const evaluation = evaluateMultimodalCreative({
        visual: {
          motionIntensity: item.motionIntensity,
          textDensity: item.textDensity,
          // Unobserved features remain undefined; never fabricated
        },
        audio: (item.speechWpm || item.audioEnergyScore) ? {
          speechWpm: item.speechWpm ?? 0,
          audioEnergy: item.audioEnergyScore ?? 0,
          silenceRatio: 0,
        } : undefined,
        historicalThreeSecondRetention: item.threeSecondRetention,
        historicalCompletionRate: item.completionRate,
      });

      // Observed beats: hook is evaluated from visual cues; unobserved beats are not mocked
      const observedNarrativeBeats: Record<NarrativeBeat, number> = {
        hook: evaluation.hookVisualScore,
        problem: 0,
        reveal: 0,
        proof: 0,
        offer: 0,
        cta: 0,
      };

      await saveContentAnalysis(sql, {
        organizationId: access.organizationId,
        brandId: data.brandId,
        postId: item.postId,
        hookVisualScore: evaluation.hookVisualScore,
        audioEnergyScore: item.audioEnergyScore ?? 0,
        speechWpm: item.speechWpm ?? 0,
        narrativeBeats: observedNarrativeBeats,
        detectedObjections: evaluation.detectedObjections,
        topCommentsSummary: "",
        visualStyle: item.visualStyle ?? "ugc",
        motionIntensity: item.motionIntensity ?? 0.5,
        textDensity: item.textDensity ?? 0.3,
        hookType: item.hookType ?? "question",
        ctaType: item.ctaType ?? "comment",
        views: item.views,
        likes: item.likes,
        comments: item.comments,
        shares: item.shares,
        threeSecondRetention: item.threeSecondRetention,
        completionRate: item.completionRate,
      });
    }

    // 4. Detect whitespace opportunities comparing against saturated angles
    const whitespaceOpps = detectWhitespaceOpportunities(
      access.organizationId,
      data.brandId,
      data.items,
      [],
      { minCompetitorPosts: 0 },
    );

    for (const opp of whitespaceOpps) {
      await saveWhitespaceOpportunity(sql, opp);
    }

    return {
      ok: true,
      profile,
      analyzedCount: data.items.length,
      opportunitiesFound: whitespaceOpps.length,
    };
  });
