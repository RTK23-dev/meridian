import assert from "node:assert/strict";
import test from "node:test";
import { aggregateResearchPatterns } from "./patterns.ts";
import { validateResearchAnalysis, type ResearchAnalysis } from "./schema.ts";

type Cite = { value: string; confidence: number; evidence: string[] };

/** A validated analysis. Every field cites seg-1 unless overridden; the transcript has four segments. */
function analysisWith(overrides: Partial<Record<string, Cite>> = {}): ResearchAnalysis {
  const base: Record<string, Cite> = {
    topic: { value: "hand care", confidence: 0.9, evidence: ["seg-1"] },
    openingMove: { value: "problem", confidence: 0.8, evidence: ["seg-1"] },
    hookMechanism: { value: "pain_point", confidence: 0.8, evidence: ["seg-1"] },
    hook: { value: "Dry hands?", confidence: 0.9, evidence: ["seg-1"] },
    structure: { value: "problem_solution", confidence: 0.8, evidence: ["seg-1"] },
    evidenceOffered: { value: "demonstration", confidence: 0.8, evidence: ["seg-1"] },
    emotionalAppeal: { value: "relief", confidence: 0.8, evidence: ["seg-1"] },
    adviceSpecificity: { value: "actionable", confidence: 0.8, evidence: ["seg-1"] },
    cta: { value: "shop_now", confidence: 0.8, evidence: ["seg-1"] },
  };
  return validateResearchAnalysis({
    ...base,
    ...overrides,
    segments: ["seg-1", "seg-2", "seg-3", "seg-4"].map((id) => ({ id, text: `Line ${id}`, startMs: null, endMs: null, role: "hook", confidence: 0.8 })),
    claims: [],
  });
}

function ad(adId: string, overrides: Partial<Record<string, Cite>> = {}) {
  return { adId, analysisId: `analysis-${adId}`, analysis: analysisWith(overrides) };
}

test("patterns are INFERRED: they count the model's labels, and a label is an inference from the transcript", () => {
  const patterns = aggregateResearchPatterns([ad("ad-a"), ad("ad-b")]);
  assert.ok(patterns.length > 0);
  for (const pattern of patterns) {
    assert.equal(pattern.state, "INFERRED", `${pattern.dimension}:${pattern.value}`);
  }
});

test("each pattern's confidence is the model's self-report, labelled as such and not as a calibrated score", () => {
  const patterns = aggregateResearchPatterns([ad("ad-a"), ad("ad-b")]);
  assert.ok(patterns.length > 0);
  for (const pattern of patterns) {
    assert.equal(pattern.confidenceSource, "model_self_report", `${pattern.dimension}:${pattern.value}`);
  }
});

test("a pattern names the ads and the transcript segments that support it", () => {
  const patterns = aggregateResearchPatterns([
    ad("ad-a", { hookMechanism: { value: "pain_point", confidence: 0.8, evidence: ["seg-1"] } }),
    ad("ad-b", { hookMechanism: { value: "pain_point", confidence: 0.7, evidence: ["seg-2", "seg-3"] } }),
    ad("ad-c", { hookMechanism: { value: "curiosity", confidence: 0.8, evidence: ["seg-4"] } }),
  ]);
  const repeated = patterns.find((pattern) => pattern.dimension === "hookMechanism" && pattern.value === "pain_point");
  assert.deepEqual(repeated?.evidence, [
    { adId: "ad-a", analysisId: "analysis-ad-a", segmentIds: ["seg-1"] },
    { adId: "ad-b", analysisId: "analysis-ad-b", segmentIds: ["seg-2", "seg-3"] },
  ]);
});

test("a creative pattern cites the segments behind all four of the fields it combines", () => {
  const patterns = aggregateResearchPatterns([
    ad("ad-a", { cta: { value: "shop_now", confidence: 0.8, evidence: ["seg-4"] } }),
  ]);
  const creative = patterns.find((pattern) => pattern.dimension === "creative_pattern");
  assert.ok(creative);
  assert.deepEqual(creative.evidence[0]!.segmentIds.slice().sort(), ["seg-1", "seg-4"]);
});

test("a label with no transcript evidence is not counted, so every emitted pattern cites at least one segment", () => {
  const patterns = aggregateResearchPatterns([
    ad("ad-a", { hookMechanism: { value: "pain_point", confidence: 0.8, evidence: [] } }),
    ad("ad-b", { hookMechanism: { value: "pain_point", confidence: 0.8, evidence: [] } }),
  ]);
  assert.equal(patterns.some((pattern) => pattern.dimension === "hookMechanism" && pattern.value === "pain_point"), false);
  assert.equal(patterns.some((pattern) => pattern.dimension === "creative_pattern"), false, "a creative pattern needs all four fields cited");
  for (const pattern of patterns) {
    assert.ok(pattern.evidence.length > 0, `${pattern.dimension}:${pattern.value}`);
    for (const entry of pattern.evidence) assert.ok(entry.segmentIds.length > 0, `${pattern.dimension}:${pattern.value}`);
  }
});

test("evidence is capped at five examples, the same five as the example ad ids", () => {
  const ads = Array.from({ length: 7 }, (_, index) => ad(`ad-${index}`));
  const pattern = aggregateResearchPatterns(ads).find((candidate) => candidate.dimension === "topic");
  assert.equal(pattern?.sampleCount, 7);
  assert.equal(pattern?.exampleAdIds.length, 5);
  assert.deepEqual(pattern?.evidence.map((entry) => entry.adId), pattern?.exampleAdIds);
});

test("the summary says the count is of model labels and is frequency only, and does not call them observations", () => {
  const pattern = aggregateResearchPatterns([ad("ad-a"), ad("ad-b")]).find((candidate) => candidate.dimension === "hookMechanism");
  assert.ok(pattern);
  assert.doesNotMatch(pattern.summary, /\bobserved\b/i);
  assert.match(pattern.summary, /model/i);
  assert.match(pattern.summary, /frequency only/i);
});
