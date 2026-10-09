import assert from "node:assert/strict";
import test from "node:test";
import { GATE_DEFAULT_MAX_ADS_PER_RUN, GATE_PARAMETER_STATE, gateMaxAdsPerRun, rankGateCandidates, type GateCandidate } from "./gate.ts";

function ad(id: string, overrides: Partial<GateCandidate> = {}): GateCandidate {
  return {
    adId: id,
    externalId: `ext-${id}`,
    copy: "Tired of smelly sponges? Try the mesh sponge.",
    headline: "Mesh sponge",
    description: "",
    capturedAt: "2026-10-01T00:00:00.000Z",
    publishedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

test("the gate's weights are labelled as seed priors, never as calibrated", () => {
  assert.equal(GATE_PARAMETER_STATE, "seed_prior");
});

test("admits the highest-scoring ads up to the run cap and skips the rest with a reason", () => {
  const candidates = [
    ad("a", { copy: "", headline: "", publishedAt: null, capturedAt: "2026-01-01T00:00:00.000Z" }),
    ad("b", { copy: "Stays fresh longer than other sponges.", publishedAt: "2026-10-05T00:00:00.000Z" }),
    ad("c", { copy: "Your kitchen deserves a better sponge.", publishedAt: "2026-10-06T00:00:00.000Z" }),
  ];
  const decision = rankGateCandidates(candidates, { maxAdsPerRun: 2, analyzedCopyKeys: new Set() });
  assert.deepEqual(decision.admitted, ["c", "b"], "newest ads with text rank first");
  assert.equal(decision.skipped.length, 1);
  assert.equal(decision.skipped[0]!.adId, "a");
  assert.equal(decision.skipped[0]!.reason, "below_run_cap");
});

test("an ad whose copy matches one already analyzed in this brand is skipped as a duplicate", () => {
  const seen = "tired of smelly sponges? try the mesh sponge. mesh sponge";
  const decision = rankGateCandidates(
    [ad("fresh"), ad("repeat")],
    { maxAdsPerRun: 10, analyzedCopyKeys: new Set([seen]) },
  );
  assert.deepEqual(decision.admitted, [], "both candidates share the analyzed copy key");
  assert.deepEqual(decision.skipped.map((item) => item.reason), ["duplicate_of_analyzed", "duplicate_of_analyzed"]);
});

test("within one run, only the first of identical copies is admitted", () => {
  const decision = rankGateCandidates(
    [ad("x", { publishedAt: "2026-10-06T00:00:00.000Z" }), ad("y", { publishedAt: "2026-10-02T00:00:00.000Z" })],
    { maxAdsPerRun: 10, analyzedCopyKeys: new Set() },
  );
  assert.deepEqual(decision.admitted, ["x"]);
  assert.equal(decision.skipped[0]!.reason, "duplicate_in_run");
});

test("ranking is deterministic when scores tie: the lower external id wins", () => {
  const decision = rankGateCandidates(
    [ad("second", { externalId: "ext-200", copy: "abcdefgh", headline: "", description: "", publishedAt: null }), ad("first", { externalId: "ext-100", copy: "ijklmnop", headline: "", description: "", publishedAt: null })],
    { maxAdsPerRun: 1, analyzedCopyKeys: new Set() },
  );
  assert.deepEqual(decision.admitted, ["first"]);
});

test("a zero cap admits nothing and records every candidate as skipped, not dropped", () => {
  const decision = rankGateCandidates([ad("only")], { maxAdsPerRun: 0, analyzedCopyKeys: new Set() });
  assert.deepEqual(decision.admitted, []);
  assert.equal(decision.skipped.length, 1);
  assert.equal(decision.skipped[0]!.reason, "below_run_cap");
  assert.ok(Number.isFinite(decision.skipped[0]!.score));
});

test("the run cap comes from RESEARCH_GATE_MAX_ADS and is bounded: unset or malformed uses the default, and the range is 0 to 200", () => {
  assert.equal(gateMaxAdsPerRun({}), GATE_DEFAULT_MAX_ADS_PER_RUN);
  assert.equal(gateMaxAdsPerRun({ RESEARCH_GATE_MAX_ADS: "   " }), GATE_DEFAULT_MAX_ADS_PER_RUN);
  assert.equal(gateMaxAdsPerRun({ RESEARCH_GATE_MAX_ADS: "abc" }), GATE_DEFAULT_MAX_ADS_PER_RUN);
  assert.equal(gateMaxAdsPerRun({ RESEARCH_GATE_MAX_ADS: "5" }), 5);
  assert.equal(gateMaxAdsPerRun({ RESEARCH_GATE_MAX_ADS: "-3" }), 0);
  assert.equal(gateMaxAdsPerRun({ RESEARCH_GATE_MAX_ADS: "999" }), 200);
});
