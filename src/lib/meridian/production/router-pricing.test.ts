import assert from "node:assert/strict";
import test from "node:test";
import { priceFor, ProductionRouter, requirementFor } from "./router.ts";
import type { CreativeSpec, ProductionProvider } from "./types.ts";

function fakeProvider(id: string, costPerSecondEstimateUsd: number, zeroSpend = false): ProductionProvider {
  return {
    id,
    capabilities: { textToVideo: true, imageToVideo: false, timelineEditing: false, voiceoverGeneration: false, zeroSpend, averageLatencySeconds: 1, costPerSecondEstimateUsd },
    health: async () => ({ id, state: "CONFIGURED", capabilities: [], detail: "", checkedAt: new Date().toISOString() }),
  } as unknown as ProductionProvider;
}

function spec(overrides: Partial<CreativeSpec> = {}): CreativeSpec {
  return {
    id: "spec-1", organizationId: "org", brandId: "brand", title: "t", modality: "video", format: "ugc",
    aspectRatio: "9:16", durationTargetSeconds: 8, hookLine: "h", script: "s", scenes: [],
    ...overrides,
  } as CreativeSpec;
}

test("a video spec is routed as a video of its duration, billed per second", () => {
  assert.deepEqual(requirementFor(spec()), { modality: "video", task: "text-to-video", durationSeconds: 8, aspectRatio: "9:16", units: 8 });
});

test("an image spec is refused until its own durable path exists, rather than sent to a video model", () => {
  assert.throws(() => requirementFor(spec({ modality: "image" })), /modality 'image' is not routed yet/);
  assert.throws(() => requirementFor(spec({ modality: "carousel" })), /modality 'carousel' is not routed yet/);
});

test("a video price is the owner's per-second declaration, and an image price is unknown rather than zero", () => {
  const declared = priceFor(fakeProvider("hypit", 0.05), "video");
  assert.deepEqual(declared, { status: "configured", unit: "per_second", amountUsd: 0.05, source: "provider declaration (hypit)", verifiedAt: null });
  const image = priceFor(fakeProvider("hypit", 0.05), "image");
  assert.equal(image.status, "unknown");
  assert.equal(image.amountUsd, null);
});

test("zero-spend routing records a known estimate of zero, from the manual workflow's declared price", async () => {
  const router = new ProductionRouter({ runtime: "production", providers: [fakeProvider("manual_cloud", 0, true), fakeProvider("hypit", 0.05)] });
  const { provider, selection } = await router.selectForSpec(spec(), "ZERO_SPEND");
  assert.equal(provider.id, "manual_cloud");
  assert.deepEqual(selection.chosen, { providerId: "manual_cloud", modelId: "manual-cloud", costKnown: true, costStatus: "configured", estimateUsd: 0 });
});

test("a provider that declares no finite per-second price has an unknown cost, never a NaN estimate", () => {
  for (const declared of [undefined, Number.NaN]) {
    const price = priceFor({ id: "undeclared", capabilities: { costPerSecondEstimateUsd: declared } } as unknown as ProductionProvider, "video");
    assert.equal(price.status, "unknown");
    assert.equal(price.amountUsd, null);
  }
});
