import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { modelChoiceSchema } from "../contracts/assets.ts";
import { decisionSchema } from "../contracts/plan.ts";
import type { ModelCatalogEntry } from "../contracts/catalog.ts";
import { catalogEstimateUsd, needOf, resolveModelChoice } from "./model-choice.ts";
import { assetSpec } from "./test/recorded.ts";

const READ_AT = "2026-10-16T09:00:00.000Z";
const AT = "2026-10-16T09:05:00.000Z";

function entry(id: string, price: ModelCatalogEntry["price"] = { unit: "per_second", usd: 0.05, sku: "per-video-second" }): ModelCatalogEntry {
  return {
    id,
    modelClasses: ["video.cinematic", "video.budget"],
    capabilities: { minSeconds: 4, maxSeconds: 10, aspectRatios: ["9:16"], resolutions: ["1080p"], firstFrame: true, lastFrame: false, refsMax: null, audio: true },
    price,
    readAt: READ_AT,
  };
}

const eligible = [entry("google/veo-3.1-lite"), entry("kwaivgi/kling-v3.0-std"), entry("alibaba/wan-2.6")];
const base = { modelClass: "video.cinematic" as const, eligible, catalogReadAt: READ_AT, at: AT, fallbackModels: ["kwaivgi/kling-v3.0-std", "google/veo-3.1"] };

function valid(result: ReturnType<typeof resolveModelChoice>): void {
  assert.ok(decisionSchema.safeParse(result.decision).success, "the decision fits the contract");
  if (result.modelChoice !== null) assert.ok(modelChoiceSchema.safeParse(result.modelChoice).success, "the choice fits the contract");
}

describe("resolveModelChoice", () => {
  it("accepts a pick that is one of the call's eligible candidates", () => {
    const result = resolveModelChoice({ ...base, pick: { modelId: "alibaba/wan-2.6", reason: "Cheapest\nfor a 5 s budget shot." }, failure: null });
    valid(result);
    assert.deepEqual(result.modelChoice, {
      provider: "openrouter",
      modelId: "alibaba/wan-2.6",
      source: "orchestrator",
      reason: "Cheapest for a 5 s budget shot.",
      catalogReadAt: READ_AT,
    });
    assert.equal(result.decision.by, "director");
    assert.equal(result.decision.chose, "openrouter:alibaba/wan-2.6");
    assert.match(result.decision.reason, /3 eligible candidates/);
  });

  it("refuses an id outside the candidates and uses the first eligible route-table target", () => {
    const result = resolveModelChoice({ ...base, pick: { modelId: "vendor/not-listed", reason: "trust me" }, failure: null });
    valid(result);
    assert.equal(result.modelChoice?.source, "fallback");
    assert.equal(result.modelChoice?.modelId, "kwaivgi/kling-v3.0-std");
    assert.match(result.modelChoice?.reason ?? "", /not one of this call's eligible candidates/);
    assert.equal(result.decision.by, "scorer");
  });

  it("uses the fallback when the role failed", () => {
    const result = resolveModelChoice({ ...base, pick: null, failure: "the model choice role failed its answer contract twice" });
    valid(result);
    assert.equal(result.modelChoice?.source, "fallback");
    assert.equal(result.modelChoice?.modelId, "kwaivgi/kling-v3.0-std");
    assert.match(result.modelChoice?.reason ?? "", /failed its answer contract twice/);
  });

  it("skips a route-table target that is not eligible and takes the next one", () => {
    const result = resolveModelChoice({ ...base, eligible: [entry("google/veo-3.1")], pick: null, failure: "refused by the reservation" });
    assert.equal(result.modelChoice?.modelId, "google/veo-3.1");
  });

  it("makes no choice with no candidates: modelChoice stays null and the call is left out", () => {
    const result = resolveModelChoice({ ...base, eligible: [], pick: { modelId: "kwaivgi/kling-v3.0-std", reason: "best" }, failure: null });
    valid(result);
    assert.equal(result.modelChoice, null, "a route-table model that is not an eligible candidate is never written as a choice");
    assert.match(result.decision.reason, /no eligible candidate/);
    assert.match(result.decision.reason, /the call is left out/);
  });

  it("bounds the director's reason to the contract's 500 characters", () => {
    const result = resolveModelChoice({ ...base, pick: { modelId: "alibaba/wan-2.6", reason: "x".repeat(900) }, failure: null });
    valid(result);
    assert.equal(result.modelChoice?.reason.length, 500);
  });
});

describe("catalogEstimateUsd and needOf", () => {
  it("prices per second by the spec's length, and per image or request as one unit, rounding up", () => {
    const spec = assetSpec({ durationMs: 6000 });
    assert.equal(catalogEstimateUsd(entry("v"), spec), 0.3);
    assert.equal(catalogEstimateUsd(entry("v", { unit: "per_second", usd: 0.0425, sku: null }), assetSpec({ durationMs: 5500 })), 0.2338, "0.23375 rounds up");
    assert.equal(catalogEstimateUsd(entry("i", { unit: "per_image", usd: 0.04, sku: "image_output" }), spec), 0.04);
    assert.equal(catalogEstimateUsd(entry("r", { unit: "per_request", usd: 0.00001, sku: "request" }), spec), 0.0001, "never 0 for a paid call");
    assert.throws(() => catalogEstimateUsd(entry("t", { unit: "per_token", usd: 0.000001, sku: null }), spec), /per token/);
  });

  it("reads the need from the spec: frames, references, the video resolution, and no model audio", () => {
    const need = needOf(assetSpec({ durationMs: 6000, firstFrame: "https://cdn.example.com/a.png", refs: ["https://cdn.example.com/r.png"] }));
    assert.deepEqual(need, { modelClass: "video.cinematic", durationSeconds: 6, aspect: "9:16", resolution: "1080p", firstFrame: true, lastFrame: false, refCount: 1, audio: false });
    assert.equal(needOf(assetSpec({ modelClass: "image.keyframe" })).resolution, null);
  });

});
