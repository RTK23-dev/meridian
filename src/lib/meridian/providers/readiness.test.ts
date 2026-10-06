import assert from "node:assert/strict";
import test from "node:test";
import { contrastRatio } from "../a11y/contrast.ts";
import { deriveAlerts } from "../observability/alerts.ts";
import { acceptPerformanceEvent } from "../performance/normalize.ts";
import { publishPausedCampaign, probeLive } from "./live.ts";
import type { Transport } from "./http.ts";
import { connectionPhase } from "./phase.ts";
import { testProviderPerformance, testProviderPublish } from "./test-provider.ts";
import { readMp4Timing } from "../video/provider.ts";

function scripted(responses: { status: number; body: string; headers?: Record<string, string> }[]): Transport {
  const queue = [...responses];
  return async () => {
    const next = queue.shift();
    if (!next) throw new Error("The scripted transport ran out of responses.");
    return { status: next.status, body: next.body, headers: next.headers ?? {} };
  };
}

test("credentials without a successful request are not connected", () => {
  const phase = connectionPhase({
    configured: true,
    disconnected: false,
    probing: false,
    syncing: false,
    lastOk: null,
    stale: false,
    lastError: "",
  });
  assert.equal(phase.phase, "NOT_CONFIGURED");
  assert.match(phase.detail, /not connected/i);
});

test("meta probe stores only an id the endpoint returned", async () => {
  const result = await probeLive(
    "meta",
    { META_ACCESS_TOKEN: "token" },
    scripted([
      { status: 200, body: JSON.stringify({ id: "user-1", name: "North" }) },
      { status: 200, body: JSON.stringify({ data: [{ id: "act_1", name: "North ads" }] }) },
      { status: 200, body: JSON.stringify({ data: [{ permission: "ads_management", status: "granted" }] }) },
    ]),
  );
  assert.equal(result.ok, true);
  assert.equal(result.accountId, "user-1");
  assert.deepEqual(result.permissions, ["ads_management"]);
});

test("meta probe does not invent an id when the response has none", async () => {
  const result = await probeLive("meta", { META_ACCESS_TOKEN: "token" }, scripted([{ status: 200, body: JSON.stringify({ name: "North" }) }]));
  assert.equal(result.ok, false);
  assert.equal(result.accountId, "");
});

test("a paused meta campaign reuses a stored id and does not create another campaign", async () => {
  const urls: string[] = [];
  const transport: Transport = async (request) => {
    urls.push(request.url);
    return { status: 200, body: JSON.stringify({ id: `new-${urls.length}` }), headers: {} };
  };
  const published = await publishPausedCampaign({
    provider: "meta",
    name: "North",
    dailyBudgetCents: 1000,
    countries: ["US"],
    pageId: "page",
    link: "https://example.com",
    message: "Soap",
    existingCampaignId: "camp-1",
    env: { META_ACCESS_TOKEN: "token", META_AD_ACCOUNT_ID: "act_1" },
    transport,
  });
  assert.equal(published.externalId, "camp-1");
  assert.equal(published.reused, true);
  assert.equal(urls.some((url) => url.endsWith("/campaigns")), false);
});

test("google publish stores nothing when the budget response has no resource", async () => {
  const published = await publishPausedCampaign({
    provider: "google",
    name: "North",
    dailyBudgetCents: 1000,
    countries: ["US"],
    pageId: "",
    link: "",
    message: "",
    env: { GOOGLE_ADS_ACCESS_TOKEN: "oauth", GOOGLE_ADS_DEVELOPER_TOKEN: "dev", GOOGLE_ADS_CUSTOMER_ID: "123" },
    transport: scripted([{ status: 200, body: JSON.stringify({ results: [{}] }) }]),
  });
  assert.equal(published.externalId, null);
  assert.match(published.error, /budget/i);
});

test("the test provider is explicit and its performance still rejects a missing denominator guess", () => {
  assert.throws(() => testProviderPublish("creative", false), /not enabled/);
  const event = testProviderPerformance("creative", true);
  assert.equal(event.externalId.startsWith("test:"), true);
  const rejected = acceptPerformanceEvent([], { ...event, impressions: null, clicks: 5 });
  assert.equal(rejected.status, "stored");
  if (rejected.status === "stored") assert.equal(rejected.metrics.ctr, null);
});

test("alerts name a stopped worker and do not invent a page send", () => {
  const alerts = deriveAlerts({
    worker: "stopped",
    scheduler: "running",
    queuedJobs: 0,
    deadJobs: 2,
    providerFailures: 0,
    publishFailures: 0,
    performanceFailures: 0,
    marketFailures: 0,
    storageFailed: false,
  });
  assert.deepEqual(alerts.map((item) => item.code), ["worker.stopped", "dead_letter.growth"]);
});

test("design tokens meet WCAG AA contrast for text", () => {
  assert.ok(contrastRatio("#121612", "#f3f0e7") >= 4.5);
  assert.ok(contrastRatio("#6d675c", "#f3f0e7") >= 4.5);
  assert.ok(contrastRatio("#6d675c", "#fbf9f4") >= 4.5);
  assert.ok(contrastRatio("#8f6232", "#f3f0e7") >= 4.5);
  assert.ok(contrastRatio("#f3f0e7", "#8f6232") >= 4.5);
  assert.ok(contrastRatio("#9c3b2e", "#fbf9f4") >= 4.5);
});

test("mp4 timing comes from the mvhd box and missing bytes do not invent a duration", () => {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 32);
  bytes[4] = 109; bytes[5] = 118; bytes[6] = 104; bytes[7] = 100; // mvhd
  view.setUint32(8 + 12, 1000);
  view.setUint32(8 + 16, 2500);
  const timing = readMp4Timing(bytes);
  assert.equal(timing?.durationMs, 2500);
  assert.equal(readMp4Timing(Uint8Array.from([0, 0, 0, 0])), null);
});
