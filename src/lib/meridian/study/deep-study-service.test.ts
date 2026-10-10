import assert from "node:assert/strict";
import test from "node:test";
import { DeepStudyService } from "./deep-study-service.ts";
import { JevDecisionService } from "../jev/service.ts";
import { JevRouter, TypeSafeDirectJevProvider } from "../jev/router.ts";
import { fixedLookup } from "../credentials/fixtures.ts";
import type { ContrastSubject } from "./contrast-engine.ts";
import type { EvidenceBundle } from "../evidence/types.ts";
import type { DiscoveredReelItem } from "../discovery/types.ts";

test("DeepStudyService: conducts contrast analysis and constructs versioned ConceptGenome with JEV judgments", async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      model: "typesafe/jev-1.13",
      inputHash: "study-hash-1",
      answers: {
        "organic.hook_mechanism.v1": {
          choice: "pattern_interrupt",
          confidence: 0.94,
          evidenceRefs: [],
        },
        "organic.format_structure.v1": {
          choice: "transformation_arc",
          confidence: 0.88,
          evidenceRefs: [],
        },
      },
    }),
  } as unknown as Response);

  const router = new JevRouter({
    typesafeProvider: new TypeSafeDirectJevProvider({
      lookup: fixedLookup("test_key"),
      baseUrl: "https://api.typesafe.ai/v1/systemone",
      fetchImpl: mockFetch as typeof fetch,
    }),
  });

  const jevService = new JevDecisionService(router);
  const deepStudy = new DeepStudyService(jevService);

  function mockReel(id: string, caption: string, views: number, likes: number, comments: number, shares = 0): DiscoveredReelItem {
    return {
      id,
      creatorHandle: "@fitnesscoach",
      niche: "fitness",
      caption,
      hashtags: ["#workout"],
      audio: { id: "a1", name: "Original", isTrending: false, firstSeenAt: "2026-10-01T00:00:00Z" },
      discoveredAt: "2026-10-08T00:00:00Z",
      discoveryTier: "graph_api",
      metrics: { views, likes, comments, shares },
    };
  }

  const subject: ContrastSubject = {
    outlierReel: mockReel("reel-outlier-1", "Stop doing crunches! Try this instead?", 180000, 12000, 850, 3200),
    baselineReels: [
      mockReel("reel-base-1", "Nice morning workout with the team", 15000, 600, 20),
      mockReel("reel-base-2", "Another gym session vlog", 18000, 700, 25),
    ],
    commentsSample: [
      "I was doing this wrong my whole life!",
      "Does this hurt lower back?",
      "Where is the link to the full routine?",
      "Need to try this tomorrow",
    ],
  };

  const bundle: EvidenceBundle = {
    id: "bundle-study-1",
    organizationId: "org-study-1",
    brandId: "brand-study-1",
    source: {
      platform: "instagram",
      sourceAdapter: "instagram_reel",
      capturedAt: "2026-10-08T00:00:00Z",
      canonicalUrl: "https://instagram.com/reel/123",
    },
    content: {
      type: "video",
      caption: "Stop doing crunches! Try this instead.",
    },
    provenance: {
      adapterId: "instagram_reel",
      sourceUrl: "https://instagram.com/reel/123",
      capturedAt: "2026-10-08T00:00:00Z",
    },
    availableEvidence: ["scene_frames", "transcript", "scene_cuts", "metadata", "claims"],
    transcript: [
      { id: "seg-1", text: "Stop doing crunches! Try this instead.", startMs: 0, endMs: 2500, confidence: 0.95 },
    ],
    metrics: {
      durationMs: 25000,
      creatorMedianViews: 16500,
    },
    evidenceRefs: [{ field: "transcript", artifactId: "bundle-study-1" }],
    createdAt: "2026-10-08T00:00:00Z",
  };

  const result = await deepStudy.conductDeepStudy({
    organizationId: "org-study-1",
    brandId: "brand-study-1",
    subject,
    bundle,
  });

  assert.ok(result.studyId.startsWith("study_"));
  assert.ok(result.concept);
  assert.equal(result.concept.positiveExamples[0], "reel-outlier-1");
  assert.equal(result.concept.negativeControls.length, 2);

  // Divergence report verification
  assert.ok(result.divergenceReport.hookDivergence.whyItPopped.length > 0);
  assert.ok(result.divergenceReport.pacingDivergence.differencePercent > 0);
  assert.ok(result.divergenceReport.commentObjectionMining.topThemes.length > 0);

  // Opportunity rating verification
  assert.ok(result.opportunityRating.ratingOutOfTen >= 1.0 && result.opportunityRating.ratingOutOfTen <= 10.0);
  assert.equal(result.opportunityRating.observedBreakout.epistemicState, "COMPUTED");
  assert.ok((result.opportunityRating.observedBreakout.viewsLift || 0) > 5.0);

  // JEV answers verification
  assert.ok(result.jevAnswers["organic.hook_mechanism.v1"]);
  assert.ok(result.jevAnswers["organic.format_structure.v1"]);
});
