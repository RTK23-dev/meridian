import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelCatalogEntry } from "../contracts/catalog.ts";
import { eligibleCandidates, rankCandidates, rejectionOf, type ModelNeed } from "./catalog-fit.ts";

const READ_AT = "2026-10-16T09:00:00.000Z";

function entry(id: string, overrides: Partial<ModelCatalogEntry> = {}, caps: Partial<ModelCatalogEntry["capabilities"]> = {}): ModelCatalogEntry {
  return {
    id,
    modelClasses: ["video.cinematic", "video.budget"],
    capabilities: {
      minSeconds: 4,
      maxSeconds: 10,
      durationsSeconds: null,
      aspectRatios: ["9:16"],
      resolutions: ["1080p"],
      firstFrame: true,
      lastFrame: true,
      refsMax: 2,
      audio: true,
      ...caps,
    },
    price: { unit: "per_second", usd: 0.1, sku: "per-video-second" },
    readAt: READ_AT,
    ...overrides,
  };
}

const need = (overrides: Partial<ModelNeed> = {}): ModelNeed => ({
  modelClass: "video.cinematic",
  durationSeconds: 5,
  aspect: "9:16",
  resolution: "1080p",
  firstFrame: false,
  lastFrame: false,
  refCount: 0,
  audio: false,
  ...overrides,
});

describe("eligibility", () => {
  it("keeps a candidate that fits every need", () => {
    const fit = eligibleCandidates(need({ firstFrame: true, lastFrame: true, refCount: 2, audio: true }), [entry("a")]);
    assert.deepEqual(fit.eligible.map((candidate) => candidate.id), ["a"]);
    assert.deepEqual(fit.rejected, []);
  });

  const cases: Array<[string, ModelNeed, ModelCatalogEntry]> = [
    ["model_class", need({ modelClass: "avatar" }), entry("x")],
    ["price_unit", need(), entry("x", { price: { unit: "per_request", usd: 0.5, sku: "request" } })],
    ["duration_unknown", need(), entry("x", {}, { minSeconds: null, maxSeconds: null })],
    ["duration_outside", need({ durationSeconds: 12 }), entry("x")],
    ["aspect_unknown", need(), entry("x", {}, { aspectRatios: null })],
    ["aspect_unsupported", need(), entry("x", {}, { aspectRatios: ["16:9"] })],
    ["resolution_unknown", need(), entry("x", {}, { resolutions: null })],
    ["resolution_unsupported", need(), entry("x", {}, { resolutions: ["720p"] })],
    ["first_frame_unknown", need({ firstFrame: true }), entry("x", {}, { firstFrame: null })],
    ["first_frame_unsupported", need({ firstFrame: true }), entry("x", {}, { firstFrame: false })],
    ["last_frame_unknown", need({ lastFrame: true }), entry("x", {}, { lastFrame: null })],
    ["last_frame_unsupported", need({ lastFrame: true }), entry("x", {}, { lastFrame: false })],
    ["refs_unknown", need({ refCount: 1 }), entry("x", {}, { refsMax: null })],
    ["refs_exceeded", need({ refCount: 3 }), entry("x")],
    ["audio_unknown", need({ audio: true }), entry("x", {}, { audio: null })],
    ["audio_unsupported", need({ audio: true }), entry("x", {}, { audio: false })],
  ];
  for (const [reason, needed, candidate] of cases) {
    it(`rejects with ${reason}`, () => {
      const fit = eligibleCandidates(needed, [candidate]);
      assert.deepEqual(fit.eligible, []);
      assert.equal(fit.rejected.length, 1);
      assert.equal(fit.rejected[0]?.reason, reason);
      assert.equal(fit.rejected[0]?.id, "x");
      assert.ok((fit.rejected[0]?.detail ?? "").length > 0, "every rejection says why");
    });
  }

  it("does not check a duration, aspect or resolution for an image call, and needs a per-image or per-request price", () => {
    const image = entry("img", { modelClasses: ["image.keyframe"], price: { unit: "per_image", usd: 0.04, sku: "image_output" } }, {
      minSeconds: null,
      maxSeconds: null,
      aspectRatios: null,
      resolutions: null,
    });
    assert.equal(rejectionOf(need({ modelClass: "image.keyframe", resolution: null, durationSeconds: 3 }), image), null);
    const tokens = { ...image, price: { unit: "per_token" as const, usd: 0.000001, sku: null } };
    assert.equal(rejectionOf(need({ modelClass: "image.keyframe", resolution: null }), tokens)?.reason, "price_unit");
  });

  it("keeps the catalog order and reports every rejection", () => {
    const fit = eligibleCandidates(need({ firstFrame: true }), [entry("a"), entry("b", {}, { firstFrame: false }), entry("c")]);
    assert.deepEqual(fit.eligible.map((candidate) => candidate.id), ["a", "c"]);
    assert.deepEqual(fit.rejected.map((rejection) => [rejection.id, rejection.reason]), [["b", "first_frame_unsupported"]]);
  });
});

describe("listed durations", () => {
  it("refuses a duration the catalog does not list, even inside the range, and checks a range-only model against the range", () => {
    const listed = entry("listed", {}, { minSeconds: 5, maxSeconds: 10, durationsSeconds: [5, 10] });
    const ranged = entry("ranged", {}, { minSeconds: 5, maxSeconds: 10, durationsSeconds: null });
    const six = need({ durationSeconds: 6 });
    assert.equal(rejectionOf(six, listed)?.reason, "duration_outside");
    assert.match(rejectionOf(six, listed)?.detail ?? "", /not one of the durations listed \(5, 10 s\)/);
    assert.equal(rejectionOf(need({ durationSeconds: 5 }), listed), null);
    assert.equal(rejectionOf(need({ durationSeconds: 10 }), listed), null);
    assert.equal(rejectionOf(six, ranged), null, "a model with only a range is checked against the range");
  });
});

describe("ranking hook", () => {
  const candidates = [entry("a"), entry("b"), entry("c")];

  it("does not reorder with the shipped preference table, which is empty", () => {
    assert.deepEqual(rankCandidates("video.cinematic", candidates).map((candidate) => candidate.id), ["a", "b", "c"]);
  });

  it("puts preferred ids first, in preference order, and keeps the rest in catalog order", () => {
    const ranked = rankCandidates("video.cinematic", candidates, { "video.cinematic": ["c", "missing", "b"] });
    assert.deepEqual(ranked.map((candidate) => candidate.id), ["c", "b", "a"]);
  });

  it("never adds or removes a candidate", () => {
    const ranked = rankCandidates("video.cinematic", [entry("a")], { "video.cinematic": ["z"] });
    assert.deepEqual(ranked.map((candidate) => candidate.id), ["a"]);
  });
});

describe("ranking by price, with no preference list", () => {
  const priced = (id: string, usd: number) => entry(id, { price: { unit: "per_second", usd, sku: "duration_seconds" } });

  it("puts the cheapest eligible candidate first, so the chooser sees the lowest price first", () => {
    const candidates = [priced("dear", 0.2), priced("cheap", 0.05), priced("mid", 0.1)];
    assert.deepEqual(rankCandidates("video.cinematic", candidates).map((candidate) => candidate.id), ["cheap", "mid", "dear"]);
  });

  it("keeps catalog order between candidates at the same price", () => {
    const candidates = [priced("first", 0.1), priced("second", 0.1), priced("cheaper", 0.05)];
    assert.deepEqual(rankCandidates("video.cinematic", candidates).map((candidate) => candidate.id), ["cheaper", "first", "second"]);
  });

  it("an explicit preference list still decides the order, and price does not override it", () => {
    const candidates = [priced("cheap", 0.05), priced("preferred", 0.2)];
    const ranked = rankCandidates("video.cinematic", candidates, { "video.cinematic": ["preferred"] });
    assert.deepEqual(ranked.map((candidate) => candidate.id), ["preferred", "cheap"]);
  });
});
