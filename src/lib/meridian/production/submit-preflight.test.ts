import assert from "node:assert/strict";
import test from "node:test";
import { injectProvider, job } from "../../../test-support/lib/meridian/testing/production-fixtures.ts";
import { productionRouter } from "./router.ts";
import { submitWithPreflight } from "./submit.ts";
import type { CreativeSpec } from "./types.ts";

const PROVIDER = "google_omni";

function videoSpec(overrides: Partial<CreativeSpec> = {}): CreativeSpec {
  return {
    id: "spec-preflight",
    organizationId: "org-preflight",
    brandId: "brand-preflight",
    title: "Preflight fixture",
    modality: "video",
    format: "ugc",
    aspectRatio: "9:16",
    durationTargetSeconds: 8,
    hookLine: "Tired of smelly sponges?",
    script: "Show the mesh layer, then the four-pack.",
    scenes: [{ index: 0, description: "Hold up the sponge", durationSeconds: 8 }],
    idempotencyKey: "spec-preflight-key",
    ...overrides,
  };
}

test("a spec with no hook is refused before the provider is called, and the refusal names the hook", async () => {
  const injected = injectProvider(PROVIDER, async (spec) => job(spec, "QUEUED"));
  try {
    const provider = productionRouter.get(PROVIDER);
    assert.ok(provider, "the fixture provider is registered");
    const result = await submitWithPreflight(provider, videoSpec({ hookLine: "" }));
    assert.equal(result.refused, true);
    assert.ok(result.refused && result.reasons.some((reason) => /hook/i.test(reason)), "the refusal names the missing hook");
    assert.equal(injected.submitted.length, 0, "the provider was not called");
  } finally {
    injected.restore();
  }
});

test("a spec with no duration is refused before the provider is called, and the refusal says the duration is outside the limits", async () => {
  const injected = injectProvider(PROVIDER, async (spec) => job(spec, "QUEUED"));
  try {
    const provider = productionRouter.get(PROVIDER);
    assert.ok(provider, "the fixture provider is registered");
    const result = await submitWithPreflight(provider, videoSpec({ durationTargetSeconds: 0 }));
    assert.equal(result.refused, true);
    assert.ok(result.refused && result.reasons.some((reason) => /duration 0s is outside allowed limits/i.test(reason)));
    assert.equal(injected.submitted.length, 0, "the provider was not called");
  } finally {
    injected.restore();
  }
});

test("a valid spec proceeds to the provider exactly once and returns the job it was given", async () => {
  const injected = injectProvider(PROVIDER, async (spec) => job(spec, "QUEUED", { providerJobId: "provider-job-1" }));
  try {
    const provider = productionRouter.get(PROVIDER);
    assert.ok(provider, "the fixture provider is registered");
    const result = await submitWithPreflight(provider, videoSpec());
    assert.equal(result.refused, false);
    assert.equal(injected.submitted.length, 1, "the provider was called once");
    if (result.refused) return;
    assert.equal(result.job.status, "QUEUED");
    assert.equal(result.job.providerJobId, "provider-job-1");
    assert.equal(result.preflight.decision, "PROCEED");
  } finally {
    injected.restore();
  }
});
