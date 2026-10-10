import assert from "node:assert/strict";
import test from "node:test";
import { priceFor, ProductionRouter, requirementFor } from "./router.ts";
import type { ImageGenerationInput, ProductionImageProvider } from "./image-providers.ts";
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
  assert.deepEqual(declared, { status: "configured", unit: "per_second", amountUsd: 0.05, source: "code-declared estimate in the hypit adapter; not checked against the provider price page", verifiedAt: null });
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

function imageStub(onGenerate: () => void): ProductionImageProvider {
  return {
    id: "google_nano_banana",
    capabilities: { zeroSpend: false },
    async health() {
      return { id: "google_nano_banana", state: "CONFIGURED", capabilities: ["text-to-image"], detail: "stub", checkedAt: new Date().toISOString() };
    },
    async generate(_input: ImageGenerationInput) {
      onGenerate();
      throw new Error("the stub must not be called by selection");
    },
  };
}

function imageSpec(aspectRatio: CreativeSpec["aspectRatio"]): CreativeSpec {
  return { ...spec(), modality: "image", aspectRatio, durationTargetSeconds: 0 };
}

test("an explicit image provider that cannot make the aspect is refused before any provider call", async () => {
  let calls = 0;
  const router = new ProductionRouter({ runtime: "testing", providers: [], imageProviders: [imageStub(() => calls++)] });
  await assert.rejects(
    router.selectImageForSpec(imageSpec("4:5"), { requestedProvider: "google_nano_banana", allowUnknownCost: true }),
    /does not offer 4:5/,
  );
  assert.equal(calls, 0);
});

test("automatic image selection refuses an unpriced provider unless the caller allows unknown costs, and never calls it", async () => {
  let calls = 0;
  const router = new ProductionRouter({ runtime: "testing", providers: [], imageProviders: [imageStub(() => calls++)] });
  await assert.rejects(router.selectImageForSpec(imageSpec("9:16"), { allowUnknownCost: false }), /allowUnknownCost/);
  assert.equal(calls, 0);
});

test("the test image double is refused outside the testing runtime, and priced at zero inside it", async () => {
  const prior = process.env.MERIDIAN_TESTING_RUNTIME;
  try {
    delete process.env.MERIDIAN_TESTING_RUNTIME;
    process.env.NODE_ENV = "development";
    const production = new ProductionRouter({ runtime: "production", providers: [] });
    await assert.rejects(
      production.selectImageForSpec(imageSpec("9:16"), { requestedProvider: "test:image", allowUnknownCost: true }),
      /test image provider is not enabled/,
    );
    process.env.MERIDIAN_TESTING_RUNTIME = "true";
    const testing = new ProductionRouter({ runtime: "testing", providers: [] });
    const { selection } = await testing.selectImageForSpec(imageSpec("9:16"), { requestedProvider: "test:image", allowUnknownCost: true });
    assert.equal(selection.chosen?.costKnown, true);
    assert.equal(selection.chosen?.estimateUsd, 0);
  } finally {
    if (prior === undefined) delete process.env.MERIDIAN_TESTING_RUNTIME;
    else process.env.MERIDIAN_TESTING_RUNTIME = prior;
  }
});
