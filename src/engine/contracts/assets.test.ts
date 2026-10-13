import assert from "node:assert/strict";
import test from "node:test";
import {
  assetCacheKey,
  assetSpecSchema,
  normalisePrompt,
  type AssetSpec,
  type ProviderAdapter,
  type ProviderPoll,
} from "./index.ts";
import { assetSpecFixture } from "./fixtures/index.ts";

const base: AssetSpec = { ...assetSpecFixture, refs: ["store://a.png"], firstFrame: "store://a.png" };
const KEY = "openrouter:seedance-2.0-mini";

test("assetCacheKey is stable for the same inputs and has the sha256 form", () => {
  const first = assetCacheKey(base, KEY);
  assert.equal(assetCacheKey({ ...base }, KEY), first);
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
});

test("assetCacheKey treats prompts that differ only in case or spacing as the same request", () => {
  const spaced = { ...base, prompt: `   ${base.prompt.toUpperCase().replace(/ /g, "   ")}\n` };
  assert.equal(assetCacheKey(spaced, KEY), assetCacheKey(base, KEY));
  assert.equal(normalisePrompt("  A   Cat\tOn  Mats "), "a cat on mats");
});

test("assetCacheKey changes when any input of the cache key changes", () => {
  const key = assetCacheKey(base, KEY);
  const changes: [string, AssetSpec, string][] = [
    ["prompt words", { ...base, prompt: "A different scene entirely" }, KEY],
    ["model class", { ...base, modelClass: "video.cinematic" }, KEY],
    ["references", { ...base, refs: ["store://a.png", "store://b.png"] }, KEY],
    ["first frame", { ...base, firstFrame: "store://other.png" }, KEY],
    ["last frame", { ...base, lastFrame: "store://end.png" }, KEY],
    ["first frame removed", { ...base, firstFrame: undefined }, KEY],
    ["duration", { ...base, durationMs: 5000 }, KEY],
    ["seed", { ...base, seed: 7 }, KEY],
    ["provider", base, "openrouter:kwaivgi/kling-v3.0-std"],
  ];
  for (const [name, spec, providerId] of changes) {
    assert.notEqual(assetCacheKey(spec, providerId), key, `cache key did not change for ${name}`);
  }
});

test("assetCacheKey ignores fields that are not part of the cache key", () => {
  const key = assetCacheKey(base, KEY);
  assert.equal(assetCacheKey({ ...base, specId: "asp_01J9ZK3M4N5P6Q7R8S9T0V1W2X", shotId: base.shotId, takes: 2 }, KEY), key);
});

test("assetCacheKey refuses an empty provider id", () => {
  assert.throws(() => assetCacheKey(base, ""));
});

test("the base asset spec is a valid asset spec with the literal 9:16 1080x1920 size", () => {
  assert.equal(assetSpecSchema.safeParse(base).success, true);
});

test("a fake provider adapter type-checks against the section 10.1 interface", async () => {
  const fake: ProviderAdapter = {
    id: "fake:stub",
    modelClass: "video.budget",
    capabilities: {
      maxSeconds: 10,
      minSeconds: 2,
      firstFrame: true,
      lastFrame: false,
      refsMax: 4,
      audio: false,
      aspect: ["9:16"],
    },
    price: (spec) => ({ estimateUsd: spec.durationMs / 1000 * 0.0336 }),
    submit: async () => ({ jobRef: "job_1" }),
    poll: async (): Promise<ProviderPoll> => ({ state: "done", uri: "store://takes/fake.mp4", actualUsd: 0.2016 }),
  };
  assert.ok(Math.abs(fake.price(base).estimateUsd - 0.2016) < 1e-9);
  assert.deepEqual(await fake.poll("job_1"), { state: "done", uri: "store://takes/fake.mp4", actualUsd: 0.2016 });
});
