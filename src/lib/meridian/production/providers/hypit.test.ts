import assert from "node:assert/strict";
import test from "node:test";
import { HypitProvider } from "./hypit.ts";
import { priceFor, ProductionRouter } from "../router.ts";
import type { CreativeSpec } from "../types.ts";

// Every test runs with a runtime URL and a key present, so a route that still made a request would have what it needs. The
// requests are recorded twice: through an injected fetch and through globalThis.fetch. Both must stay empty.

const spec: CreativeSpec = {
  id: "spec-hypit-test",
  organizationId: "org-hypit-test",
  brandId: "brand-hypit-test",
  title: "Hypit route test",
  modality: "video",
  format: "reel",
  aspectRatio: "9:16",
  durationTargetSeconds: 10,
  hookLine: "Stop",
  script: "Proof.",
  scenes: [],
  idempotencyKey: "durable-hypit-key",
};

async function withRecordedRequests(run: (provider: HypitProvider, requests: string[]) => Promise<void>): Promise<void> {
  const requests: string[] = [];
  const recorder = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const realFetch = globalThis.fetch;
  const originalUrl = process.env.HYPIT_BASE_URL;
  globalThis.fetch = recorder;
  process.env.HYPIT_BASE_URL = "https://hypit.internal";
  try {
    await run(new HypitProvider({ fetchImpl: recorder, apiKey: "workspace-hypit-key" }), requests);
  } finally {
    globalThis.fetch = realFetch;
    if (originalUrl === undefined) delete process.env.HYPIT_BASE_URL;
    else process.env.HYPIT_BASE_URL = originalUrl;
  }
}

test("health is NOT_CONFIGURED with a NOT_CONNECTED reason, and makes no request", async () => {
  await withRecordedRequests(async (provider, requests) => {
    const health = await provider.health();
    assert.equal(health.state, "NOT_CONFIGURED");
    assert.match(health.detail, /^NOT_CONNECTED: the production hypit route is not connected to the Hypit runtime\./);
    assert.match(health.detail, /src\/lib\/meridian\/hypit\/handoff\.ts is the only Hypit path/);

    const scoped = await provider.healthFor("org-hypit-test");
    assert.equal(scoped.state, "NOT_CONFIGURED");
    assert.deepEqual(requests, []);
  });
});

test("submit refuses with NOT_CONNECTED, sends nothing, and returns no receipt or bill", async () => {
  await withRecordedRequests(async (provider, requests) => {
    const job = await provider.submitJob(spec);
    assert.equal(job.status, "NOT_CONFIGURED");
    assert.equal(job.errorCode, "NOT_CONNECTED");
    assert.match(job.error ?? "", /^NOT_CONNECTED: /);
    assert.equal(job.jobId, "");
    assert.equal(job.providerJobId, undefined);
    assert.equal(job.costActualUsd, undefined);
    assert.equal(job.metadata, undefined);
    assert.deepEqual(requests, []);
  });
});

test("status checks and cancellation refuse without a request", async () => {
  await withRecordedRequests(async (provider, requests) => {
    await assert.rejects(provider.checkJobStatus("hypit-job-1", { organizationId: "org-hypit-test" }), /^Error: Cannot check Hypit job status: NOT_CONNECTED/);
    await assert.rejects(provider.cancelJob("hypit-job-1", { organizationId: "org-hypit-test" }), /^Error: Cannot cancel Hypit job: NOT_CONNECTED/);
    assert.deepEqual(requests, []);
  });
});

test("no capability is claimed: health lists none, and only the true flags are set", async () => {
  await withRecordedRequests(async (provider) => {
    const health = await provider.health();
    assert.ok(!health.capabilities.includes("voiceoverGeneration"));
    assert.ok(!health.capabilities.includes("timelineEditing"));
    assert.deepEqual(health.capabilities, []);

    assert.equal(provider.capabilities.textToVideo, false);
    assert.equal(provider.capabilities.imageToVideo, false);
    assert.equal(provider.capabilities.timelineEditing, false);
    assert.equal(provider.capabilities.voiceoverGeneration, false);
    assert.equal(provider.capabilities.zeroSpend, false);
  });
});

test("no price is reported: the per-second estimate is unknown, not a number", () => {
  const provider = new HypitProvider();
  assert.ok(!Number.isFinite(provider.capabilities.costPerSecondEstimateUsd));
  const quote = priceFor(provider, "video");
  assert.equal(quote.status, "unknown");
  assert.equal(quote.amountUsd, null);
});

test("the router never selects the route, automatically or by explicit choice", async () => {
  await withRecordedRequests(async (provider, requests) => {
    const router = new ProductionRouter({ runtime: "production", providers: [provider], imageProviders: [] });
    await assert.rejects(router.route(spec, "BALANCED"), /No configured production providers available for mode BALANCED/);
    await assert.rejects(router.route(spec, "QUALITY_FIRST"), /No configured production providers available for mode QUALITY_FIRST/);
    await assert.rejects(router.route(spec, "BALANCED", "hypit"), /Provider 'hypit' is NOT_CONFIGURED: NOT_CONNECTED: /);
    assert.deepEqual(requests, []);
  });
});
