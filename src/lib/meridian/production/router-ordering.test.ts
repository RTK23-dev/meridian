import assert from "node:assert/strict";
import test from "node:test";
import { selectOffer, type SelectionCandidate, type SelectionRequirement } from "./capability-matrix.ts";
import { TestImageProvider, type ImageGenerationInput, type ProductionImageProvider } from "./image-providers.ts";
import { configuredQuote, unknownQuote } from "./pricing.ts";
import { modelCapabilityRegistry } from "./registry.ts";
import { ProductionRouter } from "./router.ts";
import type { CostMode, CreativeSpec, ProductionProvider } from "./types.ts";

// Provider order must never decide a choice. Each test runs the same providers in both registration orders and compares.

function fakeProvider(id: string, costPerSecondEstimateUsd: number | undefined): ProductionProvider {
  return {
    id,
    capabilities: { zeroSpend: false, averageLatencySeconds: 1, costPerSecondEstimateUsd },
    health: async () => ({ id, state: "CONFIGURED", capabilities: [], detail: "", checkedAt: new Date().toISOString() }),
  } as unknown as ProductionProvider;
}

function videoSpec(): CreativeSpec {
  return {
    id: "spec-1", organizationId: "org", brandId: "brand", title: "t", modality: "video", format: "ugc",
    aspectRatio: "9:16", durationTargetSeconds: 8, hookLine: "h", script: "s", scenes: [],
  } as CreativeSpec;
}

function bothOrders<T>(items: T[]): T[][] {
  return [items, [...items].reverse()];
}

async function winnerOf(providers: ProductionProvider[], mode: CostMode, preference?: { video?: readonly string[] }): Promise<string> {
  const { provider } = await new ProductionRouter({ runtime: "production", providers, preference }).selectForSpec(videoSpec(), mode);
  return provider.id;
}

const AUTOMATIC: CostMode[] = ["BALANCED", "QUALITY_FIRST", "LOWEST_COST"];

test("the cheaper eligible provider wins under every automatic mode, whichever order the providers are registered in", async () => {
  for (const mode of AUTOMATIC) {
    for (const providers of bothOrders([fakeProvider("google_omni", 0.15), fakeProvider("hypit", 0.05)])) {
      assert.equal(await winnerOf(providers, mode), "hypit", `${mode} with ${providers.map((p) => p.id).join(", ")} registered`);
    }
  }
});

test("Gemini is an ordinary eligible option: it wins when it is the cheapest, under every automatic mode, in both orders", async () => {
  for (const mode of AUTOMATIC) {
    for (const providers of bothOrders([fakeProvider("google_omni", 0.04), fakeProvider("hypit", 0.2)])) {
      assert.equal(await winnerOf(providers, mode), "google_omni", mode);
    }
  }
});

test("on an equal price the lower provider id wins in both orders, so registration order never breaks a tie", async () => {
  for (const providers of bothOrders([fakeProvider("hypit", 0.1), fakeProvider("google_omni", 0.1)])) {
    assert.equal(await winnerOf(providers, "BALANCED"), "google_omni");
  }
});

test("an explicit preference is the caller's choice and overrides price, in both orders, and the record says so", async () => {
  for (const providers of bothOrders([fakeProvider("google_omni", 0.04), fakeProvider("hypit", 0.2)])) {
    const router = new ProductionRouter({ runtime: "production", providers, preference: { video: ["hypit"] } });
    const { provider, selection } = await router.selectForSpec(videoSpec(), "BALANCED");
    assert.equal(provider.id, "hypit");
    assert.equal(selection.basis, "explicit_preference");
  }
});

test("a provider with no declared per-second price is never chosen automatically, even when it is registered first", async () => {
  for (const providers of bothOrders([fakeProvider("hypit", undefined), fakeProvider("google_omni", 0.15)])) {
    for (const mode of AUTOMATIC) assert.equal(await winnerOf(providers, mode), "google_omni", mode);
  }
});

test("the choice records its basis: the lowest known price when no preference is set, and never a quality ranking", async () => {
  const { selection } = await new ProductionRouter({ runtime: "production", providers: [fakeProvider("google_omni", 0.15), fakeProvider("hypit", 0.05)] }).selectForSpec(videoSpec(), "QUALITY_FIRST");
  assert.equal(selection.chosen?.providerId, "hypit");
  assert.equal(selection.basis, "lowest_known_price");
});

test("rankProviders gives the same order whichever way the providers are registered, and an unpriced provider sorts last", async () => {
  const [forward, backward] = bothOrders([fakeProvider("hypit", undefined), fakeProvider("google_omni", 0.15), fakeProvider("higgsfield", 0.15)]);
  const rank = (providers: ProductionProvider[], mode: CostMode) =>
    new ProductionRouter({ runtime: "production", providers }).rankProviders(videoSpec(), mode).map((p) => p.id);
  for (const mode of AUTOMATIC) {
    assert.deepEqual(rank(forward!, mode), rank(backward!, mode), mode);
  }
  assert.deepEqual(rank(forward!, "LOWEST_COST"), ["google_omni", "higgsfield", "hypit"]);
});

test("the zero-spend manual workflow is never the automatic first choice, even though it is the cheapest", () => {
  const manual = { ...fakeProvider("manual_cloud", 0), capabilities: { zeroSpend: true, averageLatencySeconds: 1, costPerSecondEstimateUsd: 0 } } as unknown as ProductionProvider;
  const providers = [manual, fakeProvider("google_omni", 0.15)];
  for (const order of bothOrders(providers)) {
    const router = new ProductionRouter({ runtime: "production", providers: order });
    for (const mode of AUTOMATIC) assert.deepEqual(router.rankProviders(videoSpec(), mode).map((p) => p.id), ["google_omni"], mode);
    assert.equal(router.routeTheoretical(videoSpec(), "BALANCED").id, "google_omni");
    assert.deepEqual(router.rankProviders(videoSpec(), "ZERO_SPEND").map((p) => p.id), ["manual_cloud"]);
  }
});

test("LOWEST_COST ignores a preference, and BALANCED honours it in the ranking", async () => {
  const providers = [fakeProvider("google_omni", 0.15), fakeProvider("hypit", 0.05)];
  const router = new ProductionRouter({ runtime: "production", providers, preference: { video: ["google_omni"] } });
  assert.deepEqual(router.rankProviders(videoSpec(), "LOWEST_COST").map((p) => p.id), ["hypit", "google_omni"]);
  assert.deepEqual(router.rankProviders(videoSpec(), "BALANCED").map((p) => p.id), ["google_omni", "hypit"]);
});

function imageSpec(): CreativeSpec {
  return { ...videoSpec(), modality: "image", durationTargetSeconds: 0 } as CreativeSpec;
}

function imageStub(costPerImageEstimateUsd: number): ProductionImageProvider {
  return {
    id: "google_nano_banana",
    capabilities: { zeroSpend: false, costPerImageEstimateUsd },
    async health() {
      return { id: "google_nano_banana", state: "CONFIGURED", capabilities: ["text-to-image"], detail: "stub", checkedAt: new Date().toISOString() };
    },
    async generate(_input: ImageGenerationInput) {
      throw new Error("selection must not call the provider");
    },
  } as unknown as ProductionImageProvider;
}

test("image candidates: the cheaper known price wins whichever order the providers are registered in", async () => {
  // The test double is selectable only in the testing runtime, which is read from the environment on each call.
  const previous = process.env.MERIDIAN_TESTING_RUNTIME;
  process.env.MERIDIAN_TESTING_RUNTIME = "true";
  try {
    for (const providers of bothOrders<ProductionImageProvider>([imageStub(0.04), new TestImageProvider()])) {
      const router = new ProductionRouter({ runtime: "testing", providers: [], imageProviders: providers });
      const { provider } = await router.selectImageForSpec(imageSpec(), { allowUnknownCost: false });
      assert.equal(provider.id, "test:image");
    }
  } finally {
    if (previous === undefined) delete process.env.MERIDIAN_TESTING_RUNTIME;
    else process.env.MERIDIAN_TESTING_RUNTIME = previous;
  }
});

// The capability matrix itself: the candidates' order is not what decides a choice.

const REQUIREMENT: SelectionRequirement = { modality: "video", task: "text-to-video", durationSeconds: 8, aspectRatio: "9:16", units: 8 };

function candidate(providerId: string, modelId: string, price: SelectionCandidate["provider"]["price"]): SelectionCandidate {
  const record = modelCapabilityRegistry.getModel(modelId);
  if (!record) throw new Error(`fixture: no registry record ${modelId}`);
  return { provider: { id: providerId, zeroSpend: false, price }, record };
}

test("selectOffer chooses the same candidate whichever order the candidates are listed in", () => {
  const omni = candidate("google_omni", "gemini-omni-1.1-flash", configuredQuote("per_second", 0.15, "test"));
  const hypit = candidate("hypit", "hypit-hyperframes", configuredQuote("per_second", 0.05, "test"));
  for (const candidates of bothOrders([omni, hypit])) {
    const choice = selectOffer({ candidates, requirement: REQUIREMENT, registry: modelCapabilityRegistry, mode: "PREFERENCE" });
    assert.equal(choice.chosen?.providerId, "hypit");
    assert.equal(choice.basis, "lowest_known_price");
  }
});

test("selectOffer names the explicit preference as the basis, and an allowed unknown price as the unknown basis", () => {
  const omni = candidate("google_omni", "gemini-omni-1.1-flash", configuredQuote("per_second", 0.15, "test"));
  const hypit = candidate("hypit", "hypit-hyperframes", unknownQuote("per_second", "test: no price declared"));
  const preferred = selectOffer({ candidates: [omni, hypit], requirement: REQUIREMENT, registry: modelCapabilityRegistry, mode: "PREFERENCE", preference: ["google_omni"] });
  assert.equal(preferred.basis, "explicit_preference");
  const unpriced = selectOffer({ candidates: [hypit], requirement: REQUIREMENT, registry: modelCapabilityRegistry, mode: "PREFERENCE", allowUnknownCost: true });
  assert.equal(unpriced.chosen?.providerId, "hypit");
  assert.equal(unpriced.basis, "unknown_price");
});
