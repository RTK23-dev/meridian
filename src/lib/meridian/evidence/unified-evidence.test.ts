import assert from "node:assert/strict";
import test from "node:test";
import { compressEvidenceForJev, createEvidenceBundle } from "./bundle.ts";


test("compressEvidenceForJev creates compact summary and tags available evidence", () => {
  const bundle = createEvidenceBundle({
    id: "eb-1",
    organizationId: "org-1",
    brandId: "brand-1",
    source: {
      platform: "instagram",
      canonicalUrl: "https://instagram.com/p/123",
      sourceAdapter: "instagram",
      capturedAt: new Date().toISOString(),
    },
    content: {
      type: "video",
      title: "Viral Skincare Routine",
      caption: "Check out this 3-step routine",
    },
    transcript: [
      { id: "s1", startMs: 0, endMs: 2500, text: "Try this new method today!", confidence: 0.9 },
      { id: "s2", startMs: 2500, endMs: 6000, text: "It clears skin in three steps.", confidence: 0.9 },
    ],
    scenes: [
      { index: 0, startMs: 0, endMs: 2500 },
      { index: 1, startMs: 2500, endMs: 6000 },
    ],
    provenance: {
      adapterId: "instagram",
      capturedAt: new Date().toISOString(),
      sourceUrl: "https://instagram.com/p/123",
    },
  });

  const compressed = compressEvidenceForJev(bundle);
  assert.equal(compressed.platform, "instagram");
  assert.ok(compressed.availableEvidence.includes("transcript"));
  assert.ok(compressed.availableEvidence.includes("scene_cuts"));
  assert.match(compressed.transcriptSummary!, /Try this new method/);
  assert.match(compressed.sceneSummary!, /Total scenes: 2/);
});

