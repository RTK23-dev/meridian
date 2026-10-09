import assert from "node:assert/strict";
import test from "node:test";
import { DeepStudyContrastEngine, type ContrastSubject } from "./contrast-engine.ts";
import { validateAntiGenericStandards, type FormulaCard } from "./formula-card.ts";
import type { DiscoveredReelItem } from "../discovery/types.ts";

function createMockReel(
  overrides: Partial<DiscoveredReelItem> & { views?: number } = {}
): DiscoveredReelItem {
  const { views, metrics, ...rest } = overrides;
  return {
    id: "reel-mock-1",
    permalink: "https://www.instagram.com/reel/Cmock1/",
    externalPostId: "Cmock1",
    creatorHandle: "creator_a",
    creatorFollowerCount: 18000,
    creatorLast30MedianViews: 4000,
    creatorVariance: 0.8,
    niche: "Fitness & Wellness",
    caption: "Stop doing standard lunges if you want bigger glutes!",
    hashtags: ["#glutes", "#gym"],
    audio: {
      id: "audio-1",
      name: "Trending Audio",
      isTrending: true,
      reelCount: 12000,
      firstSeenAt: "2026-10-01T00:00:00Z",
    },
    durationMs: 25000,
    postedAt: "2026-10-05T00:00:00Z",
    discoveredAt: "2026-10-06T00:00:00Z",
    discoveryTier: "graph_api",
    metrics: {
      views: views ?? metrics?.views ?? 180000,
      likes: metrics?.likes ?? 12000,
      comments: metrics?.comments ?? 650,
      shares: metrics?.shares,
      saves: metrics?.saves,
    },
    ...rest,
  };
}

test("DeepStudyContrastEngine analyzes divergence and mines audience comments", () => {
  const outlier = createMockReel({ views: 180000 });
  const baseline = [
    createMockReel({ id: "base-1", caption: "Morning workout routine vlog", views: 3800 }),
    createMockReel({ id: "base-2", caption: "My favorite protein shakes", views: 4200 }),
  ];

  const comments = [
    "Where is that resistance band from?? Need the link!",
    "Is this too expensive for beginners?",
    "Finally someone explains why lunges hurt my knees",
  ];

  const subject: ContrastSubject = {
    outlierReel: outlier,
    baselineReels: baseline,
    commentsSample: comments,
  };

  const report = DeepStudyContrastEngine.analyzeContrast(subject);
  assert.equal(report.hookDivergence.outlierMechanism, "negative_hook");
  assert.ok(report.hookDivergence.whyItPopped.includes("Negative pattern interrupt"));
  assert.ok(report.transferabilityAnalysis.score >= 80);
  assert.ok(report.commentObjectionMining.topThemes.includes("Where to purchase inquiry"));
  assert.ok(report.counterfactual.length > 20);
});

test("DeepStudyContrastEngine generates verified FormulaCard meeting anti-generic standards", () => {
  const outlier = createMockReel({ views: 180000 });
  const subject: ContrastSubject = {
    outlierReel: outlier,
    baselineReels: [createMockReel({ views: 4000 })],
    commentsSample: ["Where is the band from?", "I wasted so much money on the other brand"],
  };

  const report = DeepStudyContrastEngine.analyzeContrast(subject);
  const card = DeepStudyContrastEngine.generateFormulaCard(subject, report);

  assert.equal(card.beats.length, 4);
  assert.equal(card.beats[0].startPercent, 0);
  assert.equal(card.beats[3].endPercent, 100);
  assert.equal(card.editGrammar.cutPacingCategory, "hyper_fast");
  assert.equal(card.evidenceCitations.length >= 2, true);

  const validation = validateAntiGenericStandards(card);
  assert.equal(validation.isValid, true);
  assert.equal(validation.errors.length, 0);
});

test("validateAntiGenericStandards rejects cards with banned fluff strings", () => {
  const invalidCard: FormulaCard = {
    id: "invalid-1",
    title: "Bad Card",
    niche: "Fitness",
    sourceReelPermalink: "https://instagram.com/reel/123",
    hookMechanismSlug: "negative_hook",
    formatStructureSlug: "listicle",
    emotionalDriverSlug: "curiosity",
    beats: [
      { name: "Beat 1", startPercent: 0, endPercent: 50, purpose: "engaging content", evidenceTimestampSec: 1, editDirective: "Cut", suggestedSourceRank: 1 },
      { name: "Beat 2", startPercent: 50, endPercent: 100, purpose: "high-quality visuals", evidenceTimestampSec: 10, editDirective: "Cut", suggestedSourceRank: 2 },
    ],
    editGrammar: {
      targetShotDurationSec: 2,
      cutPacingCategory: "creator_standard",
      bRollRatioPercent: 50,
      soundDesignTriggers: [],
      captionStyle: "karaoke_pop",
      textSafeZonePlacement: "upper_center",
    },
    minedAudienceLexicon: { commonDesires: [], commonObjections: [], catchphrases: [] },
    productEntryPoints: [],
    transferabilityScore: 70,
    counterfactualAnalysis: "Short",
    evidenceCitations: [],
  };

  const res = validateAntiGenericStandards(invalidCard);
  assert.equal(res.isValid, false);
  assert.ok(res.errors.some((e) => e.includes("engaging content")));
  assert.ok(res.errors.some((e) => e.includes("high-quality visuals")));
  assert.ok(res.errors.some((e) => e.includes("counterfactual")));
});
