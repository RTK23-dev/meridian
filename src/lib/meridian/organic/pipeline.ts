/**
 * End-to-End Social Scraping & Organic Learning Pipeline
 *
 * Scrapes any public social URL (TikTok, Instagram, YouTube, Twitter/X, Threads,
 * Facebook, Pinterest, Reddit, LinkedIn), extracts psychological creative traits,
 * and feeds the post directly into JEV's Bayesian learning flywheel.
 */

import type { Sql } from "./creators.ts";
import { upsertCreatorProfile } from "./creators.ts";
import { scrapeSocialUrl, type ScrapedSocialPost } from "../sources/scraper/social-scraper.ts";
import { ingestOrganicContentForLearning } from "./learning-bridge.ts";
import { recordCreatorSnapshot } from "./creator-snapshots.ts";

export type ScrapeAndLearnInput = {
  organizationId: string;
  brandId: string;
  url: string;
  angle?: string;
  hookType?: string;
  format?: string;
  proofType?: string;
  visualStyle?: string;
  estimatedViews?: number;
  comments?: Array<{ text: string; author?: string; likes?: number }>;
};

export async function scrapeAndLearnOrganicContent(
  sql: Sql,
  input: ScrapeAndLearnInput,
): Promise<{
  scraped: ScrapedSocialPost;
  learnedPatternsCount: number;
  creativeId: string;
}> {
  // 1. Scrape public social URL across all supported networks
  const scraped = await scrapeSocialUrl(input.url);

  // 2. Infer angle, hook, and format from text if not explicitly provided
  const text = (scraped.caption || scraped.title || "").toLowerCase();

  let inferredAngle = input.angle || "demonstration";
  if (text.includes("unboxing") || text.includes("unbox") || text.includes("haul")) {
    inferredAngle = "unboxing";
  } else if (text.includes("problem") || text.includes("stop doing") || text.includes("mistake") || text.includes("ruining")) {
    inferredAngle = "pain_point";
  } else if (text.includes("secret") || text.includes("hack") || text.includes("routine") || text.includes("didn't know")) {
    inferredAngle = "curiosity";
  } else if (text.includes("results") || text.includes("before") || text.includes("after") || text.includes("glow up")) {
    inferredAngle = "transformation";
  } else if (text.includes("why you should never") || text.includes("worst") || text.includes("stop buying") || text.includes("overrated")) {
    inferredAngle = "contrarian";
  } else if (text.includes("dermatologist") || text.includes("expert") || text.includes("doctor") || text.includes("tested")) {
    inferredAngle = "authority";
  } else if (text.includes("run don't walk") || text.includes("selling out") || text.includes("limited")) {
    inferredAngle = "urgency";
  } else if (text.includes("review") || text.includes("viral") || text.includes("obsessed") || text.includes("trending")) {
    inferredAngle = "social_proof";
  }

  let inferredHook = input.hookType || "spoken";
  if (text.includes("?") || text.startsWith("why") || text.startsWith("how")) {
    inferredHook = "question";
  } else if (text.includes("stop") || text.includes("don't") || text.includes("never") || text.includes("best ever")) {
    inferredHook = "bold_claim";
  } else if (text.includes("pov") || text.includes("that moment") || text.includes("when you")) {
    inferredHook = "pov_relatable";
  } else if (text.includes("wait till") || text.includes("watch till the end") || text.includes("secret")) {
    inferredHook = "curiosity_gap";
  } else if (text.includes("here's what happened") || text.includes("day 1 vs day 30")) {
    inferredHook = "result_first";
  }

  let inferredFormat = input.format || "ugc";
  if (text.includes("tutorial") || text.includes("how to") || text.includes("routine")) {
    inferredFormat = "demo";
  } else if (text.includes("review") || text.includes("honest thoughts") || text.includes("tested")) {
    inferredFormat = "testimonial";
  } else if (text.includes("skit") || text.includes("acting") || text.includes("me trying")) {
    inferredFormat = "skit";
  } else if (text.includes("top 3") || text.includes("top 5") || text.includes("reasons why") || text.includes("things i")) {
    inferredFormat = "listicle";
  } else if (text.includes("vs") || text.includes("compared to") || text.includes("dupe")) {
    inferredFormat = "comparison";
  }
  const observedViews = scraped.views;
  const estimatedViews = input.estimatedViews;
  const views = observedViews ?? estimatedViews ?? 0;

  // 3. Optional creator snapshot recording
  if (scraped.authorHandle) {
    try {
      const creator = await upsertCreatorProfile(sql, {
        organizationId: input.organizationId,
        platform: scraped.platform,
        handle: scraped.authorHandle,
        displayName: scraped.authorName,
        engagementRate: scraped.likes && views > 0 ? scraped.likes / views : undefined,
      });
      await recordCreatorSnapshot(sql, {
        creatorId: creator.id,
        organizationId: input.organizationId,
        viewsMedian: views,
        likesMedian: scraped.likes,
        commentsMedian: scraped.comments,
      });
    } catch {
      // Best-effort creator snapshot
    }
  }

  // 4. Ingest into JEV Bayesian learning engine
  const result = await ingestOrganicContentForLearning(sql, {
    organizationId: input.organizationId,
    brandId: input.brandId,
    platform: scraped.platform,
    sourceUrl: scraped.url,
    title: scraped.title,
    rawText: scraped.caption,
    angle: inferredAngle,
    hookType: inferredHook,
    format: inferredFormat,
    proofType: input.proofType,
    visualStyle: input.visualStyle,
    metrics: {
      views,
      likes: scraped.likes ?? 0,
      comments: scraped.comments ?? 0,
      shares: scraped.shares ?? 0,
    },
    commentsList: input.comments,
  });

  return {
    scraped,
    learnedPatternsCount: result.learnedPatternsCount,
    creativeId: result.creativeId,
  };
}
