import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../learning/store.ts";
import {
  NARRATIVE_BEATS,
  BEAT_WINDOWS,
  engagementRate,
  averageEngagementRate,
  estimatePostingCadence,
  decileTraits,
  extractTopHooks,
  findSaturatedAngles,
  analyzeAccountPortfolio,
  detectWhitespaceOpportunities,
  storeAccountProfile,
  getAccountProfile,
  storeContentAnalysis,
  getContentAnalyses,
  storeWhitespaceOpportunity,
  getWhitespaceOpportunities,
  type ContentItem,
} from "./account-engine.ts";
import {
  predictHookRetention,
  scoreSpeechProsody,
  scoreShotPacing,
  extractObjectionsFromComments,
  evaluateMultimodalCreative,
} from "./multimodal-scorer.ts";

test("JEV Account: 6-beat sequence narrative boundaries cover typical 30-35s creative", () => {
  assert.equal(NARRATIVE_BEATS.length, 6);
  assert.deepEqual(Array.from(NARRATIVE_BEATS), ["hook", "problem", "reveal", "proof", "offer", "cta"]);

  // Ensure continuous coverage from 0 to 35 seconds
  assert.equal(BEAT_WINDOWS.hook.start, 0);
  assert.equal(BEAT_WINDOWS.hook.end, 3);
  assert.equal(BEAT_WINDOWS.problem.start, 3);
  assert.equal(BEAT_WINDOWS.cta.end, 35);
});

test("JEV Account: engagement rate math never invents data and clamps strictly", () => {
  // Zero views must yield 0, not NaN or infinity
  const zeroViewItem: ContentItem = {
    id: "p0",
    platform: "instagram",
    postId: "post-0",
    views: 0,
    likes: 10,
    comments: 2,
    shares: 1,
    threeSecondRetention: 0,
    completionRate: 0,
  };
  assert.equal(engagementRate(zeroViewItem), 0);

  // Normal engagement
  const normalItem: ContentItem = {
    id: "p1",
    platform: "instagram",
    postId: "post-1",
    views: 1000,
    likes: 100,
    comments: 20,
    shares: 10,
    threeSecondRetention: 0.45,
    completionRate: 0.20,
  };
  // (100 + 20 + 10) / 1000 = 0.13
  assert.equal(Math.round(engagementRate(normalItem)! * 1000) / 1000, 0.13);

  // Empty list average
  assert.equal(averageEngagementRate([]), 0);
});

test("JEV Account: posting cadence calculation calculates median interval in hours", () => {
  // Fewer than 2 posts returns 0
  assert.equal(estimatePostingCadence([]), 0);
  assert.equal(
    estimatePostingCadence([{ id: "1", platform: "ig", postId: "1", views: 10, likes: 1, comments: 0, shares: 0, threeSecondRetention: 0, completionRate: 0, publishedAt: "2026-01-01T00:00:00Z" }]),
    0,
  );

  // 3 posts spaced 24 hours apart
  const posts: ContentItem[] = [
    { id: "1", platform: "ig", postId: "1", views: 10, likes: 1, comments: 0, shares: 0, threeSecondRetention: 0, completionRate: 0, publishedAt: "2026-01-01T12:00:00Z" },
    { id: "2", platform: "ig", postId: "2", views: 10, likes: 1, comments: 0, shares: 0, threeSecondRetention: 0, completionRate: 0, publishedAt: "2026-01-02T12:00:00Z" },
    { id: "3", platform: "ig", postId: "3", views: 10, likes: 1, comments: 0, shares: 0, threeSecondRetention: 0, completionRate: 0, publishedAt: "2026-01-03T12:00:00Z" },
  ];
  assert.equal(estimatePostingCadence(posts), 24);
});

test("JEV Account: decile separation isolates top 10% vs bottom 10% creative traits", () => {
  const items: ContentItem[] = [];
  for (let i = 0; i < 20; i++) {
    items.push({
      id: `p-${i}`,
      platform: "tiktok",
      postId: `post-${i}`,
      views: 1000,
      likes: i * 10, // engagement increases with i
      comments: i,
      shares: 0,
      threeSecondRetention: 0.3,
      completionRate: 0.1,
      hookType: i >= 18 ? "bold_curiosity" : "generic_intro",
      angle: i >= 18 ? "counterintuitive_secret" : "standard_feature",
    });
  }

  const { top, bottom } = decileTraits(items, 10);
  // Cutoff is 20 * 0.1 = 2 items
  assert.equal(top["hook:bold_curiosity"], 2);
  assert.equal(top["angle:counterintuitive_secret"], 2);
  assert.equal(bottom["hook:generic_intro"], 2);
  assert.equal(bottom["angle:standard_feature"], 2);
});

test("JEV Account: hook extraction and saturation filtering", () => {
  const items: ContentItem[] = [
    { id: "1", platform: "ig", postId: "1", views: 100, likes: 10, comments: 1, shares: 0, threeSecondRetention: 0, completionRate: 0, hookType: "question", angle: "price" },
    { id: "2", platform: "ig", postId: "2", views: 100, likes: 10, comments: 1, shares: 0, threeSecondRetention: 0, completionRate: 0, hookType: "question", angle: "price" },
    { id: "3", platform: "ig", postId: "3", views: 100, likes: 10, comments: 1, shares: 0, threeSecondRetention: 0, completionRate: 0, hookType: "story", angle: "speed" },
  ];

  const topHooks = extractTopHooks(items);
  assert.equal(topHooks[0], "question");

  // price is in 2/3 (66%) of items -> saturated (>= 30%)
  const saturated = findSaturatedAngles(items, 0.3);
  assert.ok(saturated.includes("price"));
});

test("JEV Account: whitespace opportunity detection identifies unsaturated high-performing angles", () => {
  const orgId = "org_1";
  const brandId = "brand_1";

  const ownItems: ContentItem[] = [
    { id: "o1", platform: "ig", postId: "o1", views: 1000, likes: 150, comments: 20, shares: 10, threeSecondRetention: 0.4, completionRate: 0.2, angle: "dermatologist_backed" },
    { id: "o2", platform: "ig", postId: "o2", views: 1000, likes: 160, comments: 25, shares: 15, threeSecondRetention: 0.5, completionRate: 0.25, angle: "dermatologist_backed" },
  ];

  const competitorItems: ContentItem[] = [
    // 8 posts on saturated "discount" angle
    ...Array.from({ length: 8 }, (_, i) => ({
      id: `c-disc-${i}`, platform: "ig", postId: `c-disc-${i}`, views: 1000, likes: 50, comments: 5, shares: 2, threeSecondRetention: 0.2, completionRate: 0.1, angle: "discount"
    })),
    // 2 posts on unsaturated "clean_ingredients" angle
    { id: "c-clean-1", platform: "ig", postId: "c-clean-1", views: 1000, likes: 120, comments: 15, shares: 5, threeSecondRetention: 0.4, completionRate: 0.2, angle: "clean_ingredients" },
    { id: "c-clean-2", platform: "ig", postId: "c-clean-2", views: 1000, likes: 130, comments: 20, shares: 8, threeSecondRetention: 0.4, completionRate: 0.2, angle: "clean_ingredients" },
  ];

  const opps = detectWhitespaceOpportunities(orgId, brandId, ownItems, competitorItems, { minCompetitorPosts: 5 });

  // discount angle has 8/10 = 80% saturation (> 25%), so it should be filtered out
  const discountOpp = opps.find((o) => o.unsaturatedAngle === "discount");
  assert.equal(discountOpp, undefined);

  // clean_ingredients has 2/10 = 20% saturation (<= 25%), so it should be flagged as whitespace!
  const cleanOpp = opps.find((o) => o.unsaturatedAngle === "clean_ingredients");
  assert.ok(cleanOpp);
  assert.equal(cleanOpp.competitorSaturationScore, 0.2);
  assert.ok(cleanOpp.expectedWinProbability > 0.5);
});

test("JEV Account: 500-post dataset portfolio analysis benchmark runs in < 1.5 seconds", () => {
  const posts: ContentItem[] = [];
  const hookTypes = ["bold_statement", "question", "visual_proof", "problem_agitation", "pov"];
  const angles = ["clinical_proof", "convenience", "price_value", "ingredient_breakdown", "lifestyle"];
  const baseTime = Date.now() - 500 * 3600 * 1000;

  for (let i = 0; i < 500; i++) {
    posts.push({
      id: `sim-${i}`,
      platform: "instagram",
      postId: `post-sim-${i}`,
      views: 500 + (i % 20) * 100,
      likes: 20 + (i % 15) * 5,
      comments: 2 + (i % 5),
      shares: 1 + (i % 3),
      threeSecondRetention: 0.3 + (i % 10) * 0.04,
      completionRate: 0.15 + (i % 8) * 0.02,
      hookType: hookTypes[i % hookTypes.length],
      angle: angles[i % angles.length],
      publishedAt: new Date(baseTime + i * 3600 * 1000).toISOString(),
    });
  }

  const start = performance.now();
  const profile = analyzeAccountPortfolio("org_test", "brand_test", "instagram", "meridian_test", posts);
  const durationMs = performance.now() - start;

  assert.equal(profile.postCount, 500);
  assert.ok(profile.avgEngagementRate > 0);
  assert.ok(profile.postingCadenceHours > 0);
  assert.ok(profile.topHooks.length > 0);
  assert.ok(durationMs < 1500, `Benchmark took ${durationMs.toFixed(2)}ms, must be < 1500ms`);
});

test("JEV Multimodal Scorer: predicts hook retention and respects clutter penalty", () => {
  // High energy visual with clean typography
  const cleanHook = predictHookRetention({
    motionIntensity: 0.85,
    facePresence: 0.9,
    typographyWeight: 0.8,
    contrastRatio: 0.75,
    textDensity: 0.2, // clean
  }, {
    speechWpm: 165,
    audioEnergy: 0.8,
    silenceRatio: 0.0,
  });

  // Cluttered visual with low motion and silence
  const clutteredHook = predictHookRetention({
    motionIntensity: 0.1,
    facePresence: 0.0,
    typographyWeight: 0.3,
    contrastRatio: 0.2,
    textDensity: 0.95, // heavy clutter penalty
  }, {
    speechWpm: 90,
    audioEnergy: 0.2,
    silenceRatio: 0.7, // dead air penalty
  });

  assert.ok(cleanHook.predictedRetention > 0.65, `Clean hook was ${cleanHook.predictedRetention}`);
  assert.ok(clutteredHook.predictedRetention < 0.35, `Cluttered hook was ${clutteredHook.predictedRetention}`);
  assert.ok(cleanHook.predictedRetention > clutteredHook.predictedRetention);
});

test("JEV Multimodal Scorer: speech prosody sweet spot and shot pacing", () => {
  // Sweet spot WPM (160)
  const sweet = scoreSpeechProsody({ speechWpm: 165, audioEnergy: 0.7, silenceRatio: 0.02 });
  assert.equal(sweet.wpmScore, 1.0);
  assert.ok(sweet.prosodyScore > 0.7);

  // Too slow (70 WPM)
  const slow = scoreSpeechProsody({ speechWpm: 70, audioEnergy: 0.5, silenceRatio: 0.1 });
  assert.ok(slow.wpmScore < 0.6);

  // Shot pacing (cuts every 1.8s is optimal)
  const optimalPacing = scoreShotPacing(1.8);
  assert.equal(optimalPacing, 1.0);

  // Static (cuts every 6.0s is boring)
  const boringPacing = scoreShotPacing(6.0);
  assert.ok(boringPacing < 0.5);
});

test("JEV Multimodal Scorer: mines objections from customer comments accurately", () => {
  const comments = [
    "Is this actually legit or a scam?",
    "Way too expensive for only 30ml",
    "Did anyone break out or have an allergic reaction?",
    "How long does it take to see results?",
    "I placed my order 3 weeks ago and shipping tracking is lost",
    "Loved the color on my skin!",
  ];

  const objections = extractObjectionsFromComments(comments);
  assert.ok(objections.includes("Efficacy / Authenticity skepticism"));
  assert.ok(objections.includes("Price / Value objection"));
  assert.ok(objections.includes("Safety / Side-effect concern"));
  assert.ok(objections.includes("Time-to-result uncertainty"));
  assert.ok(objections.includes("Shipping / Logistics complaint"));
  // Generic praise is not an objection
  assert.equal(objections.length, 5);
});

test("JEV Multimodal Scorer: full evaluation produces clamped overall creative score", () => {
  const evalResult = evaluateMultimodalCreative({
    visual: {
      motionIntensity: 0.8,
      facePresence: 0.7,
      textDensity: 0.25,
      contrastRatio: 0.7,
      typographyWeight: 0.8,
      avgCutLengthSec: 2.0,
    },
    audio: {
      speechWpm: 160,
      audioEnergy: 0.75,
      silenceRatio: 0.05,
    },
    comments: ["is this expensive?"],
    historicalThreeSecondRetention: 0.62,
    historicalCompletionRate: 0.28,
  });

  assert.ok(evalResult.overallDnaScore >= 0 && evalResult.overallDnaScore <= 1);
  assert.ok(evalResult.predictedHookRetention >= 0 && evalResult.predictedHookRetention <= 1);
  assert.ok(evalResult.hookVisualScore >= 0 && evalResult.hookVisualScore <= 1);
  assert.equal(evalResult.detectedObjections.length, 1);
});

test("JEV Account Database: stores and retrieves profiles, analyses, and whitespace with tenant isolation", async () => {
  const pg = new PGlite();
  await pg.waitReady;

  await pg.exec(`
    create table if not exists jev_account_profiles (
      id text primary key,
      organization_id text not null,
      brand_id text not null,
      platform text not null,
      account_handle text not null default '',
      post_count integer not null default 0,
      follower_count integer not null default 0,
      avg_engagement_rate double precision not null default 0,
      posting_cadence_hours double precision not null default 0,
      brand_archetype text not null default '',
      top_hooks jsonb not null default '[]',
      saturated_angles jsonb not null default '[]',
      top_decile_traits jsonb not null default '{}',
      bottom_decile_traits jsonb not null default '{}',
      rolling_window_days integer not null default 30,
      analysis_version integer not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists jev_content_analyses (
      id text primary key,
      organization_id text not null,
      brand_id text not null,
      account_id text,
      post_id text not null default '',
      media_sha256 text not null default '',
      hook_visual_score double precision not null default 0,
      audio_energy_score double precision not null default 0,
      speech_wpm double precision not null default 0,
      narrative_beats jsonb not null default '{}',
      detected_objections jsonb not null default '[]',
      top_comments_summary text not null default '',
      visual_style text not null default '',
      color_palette text not null default '',
      motion_intensity double precision not null default 0,
      text_density double precision not null default 0,
      hook_type text not null default '',
      cta_type text not null default '',
      engagement_views integer not null default 0,
      engagement_likes integer not null default 0,
      engagement_comments integer not null default 0,
      engagement_shares integer not null default 0,
      three_second_retention double precision not null default 0,
      completion_rate double precision not null default 0,
      created_at timestamptz not null default now()
    );

    create table if not exists jev_whitespace_opportunities (
      id text primary key,
      organization_id text not null,
      brand_id text not null,
      category text not null default '',
      unsaturated_angle text not null default '',
      competitor_saturation_score double precision not null default 0,
      expected_win_probability double precision not null default 0,
      supporting_evidence jsonb not null default '[]',
      status text not null default 'proposed',
      created_at timestamptz not null default now()
    );
  `);

  const sql: Sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let query = strings[0];
    const params: unknown[] = [];
    for (let i = 0; i < values.length; i++) {
      params.push(values[i]);
      query += `$${i + 1}` + strings[i + 1];
    }
    const res = await pg.query(query, params);
    return res.rows;
  }) as any;

  const orgA = "org_alpha";
  const brandA = "brand_alpha";
  const orgB = "org_beta";
  const brandB = "brand_beta";

  // 1. Store profile for Org A
  await storeAccountProfile(sql, {
    id: "prof_a",
    organizationId: orgA,
    brandId: brandA,
    platform: "instagram",
    accountHandle: "alpha_brand",
    postCount: 42,
    followerCount: 15000,
    avgEngagementRate: 0.054,
    postingCadenceHours: 24,
    brandArchetype: "ugc_authentic",
    topHooks: ["question", "before_after"],
    saturatedAngles: ["price_drop"],
    topDecileTraits: { "hook:question": 4 },
    bottomDecileTraits: { "hook:static": 3 },
    rollingWindowDays: 30,
    analysisVersion: 1,
  });

  // 2. Query Org A profile
  const profileA = await getAccountProfile(sql, orgA, brandA, "instagram");
  assert.ok(profileA);
  assert.equal(profileA.accountHandle, "alpha_brand");
  assert.equal(profileA.postCount, 42);
  assert.deepEqual(profileA.topHooks, ["question", "before_after"]);

  // 3. Tenant isolation: Org B cannot see Org A's profile
  const profileB = await getAccountProfile(sql, orgB, brandB, "instagram");
  assert.equal(profileB, null);

  // 4. Content analyses persistence & isolation
  await storeContentAnalysis(sql, {
    id: "ca_1",
    organizationId: orgA,
    brandId: brandA,
    postId: "post_100",
    hookVisualScore: 0.88,
    audioEnergyScore: 0.72,
    speechWpm: 165,
    narrativeBeats: { hook: 0.9, problem: 0.8, reveal: 0.85, proof: 0.7, offer: 0.65, cta: 0.7 },
    detectedObjections: ["Price objection"],
    visualStyle: "ugc",
    views: 12000,
    likes: 850,
    comments: 42,
    shares: 20,
    threeSecondRetention: 0.65,
    completionRate: 0.30,
  });

  const analysesA = await getContentAnalyses(sql, orgA, brandA);
  assert.equal(analysesA.length, 1);
  assert.equal(analysesA[0].postId, "post_100");
  assert.equal(analysesA[0].hookVisualScore, 0.88);
  assert.deepEqual(analysesA[0].detectedObjections, ["Price objection"]);

  const analysesB = await getContentAnalyses(sql, orgB, brandB);
  assert.equal(analysesB.length, 0);

  // 5. Whitespace opportunities persistence & isolation
  await storeWhitespaceOpportunity(sql, {
    id: "ws_1",
    organizationId: orgA,
    brandId: brandA,
    category: "instagram",
    unsaturatedAngle: "dermatologist_breakdown",
    competitorSaturationScore: 0.12,
    expectedWinProbability: 0.78,
    supportingEvidence: ["Only 2 competitor posts found", "Avg engagement 7.2%"],
    status: "proposed",
  });

  const oppsA = await getWhitespaceOpportunities(sql, orgA, brandA);
  assert.equal(oppsA.length, 1);
  assert.equal(oppsA[0].unsaturatedAngle, "dermatologist_breakdown");
  assert.equal(oppsA[0].expectedWinProbability, 0.78);

  const oppsB = await getWhitespaceOpportunities(sql, orgB, brandB);
  assert.equal(oppsB.length, 0);
});
