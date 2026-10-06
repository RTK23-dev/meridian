import assert from "node:assert/strict";
import test from "node:test";
import { learnPatterns } from "../learning/engine.ts";
import { deliverAlert, dedupeAlert } from "../alerts/deliver.ts";
import { approvedThresholds } from "../calibration/active.ts";
import { approveThresholdChange, proposeThresholdChange } from "../calibration/propose.ts";
import { authorizationUrl, exchangeOauthCode, hashOauthState, oauthStateMatches, openSecret, sealSecret } from "../oauth/flow.server.ts";
import { operationRecord, redactSecrets } from "../observability/redact.ts";
import { ingestPerformanceRows, metaInsightEvent } from "../performance/sync.ts";
import { performanceScheduleDecision } from "../performance/schedule.ts";
import type { Transport } from "./http.ts";
import { publishGoogleFlow } from "./google-ads.ts";
import { confirmedExternalId, reusableExternalId } from "./ownership.ts";
import { publishTikTokFlow } from "./tiktok.ts";
import { verifyWebhook, signWebhookBody } from "../webhooks/verify.ts";

function scripted(responses: { urlIncludes?: string; status: number; body: string }[]): Transport {
  const queue = [...responses];
  return async (request) => {
    const next = queue.shift();
    if (!next) throw new Error(`No scripted response for ${request.url}`);
    if (next.urlIncludes && !request.url.includes(next.urlIncludes)) {
      throw new Error(`Expected ${next.urlIncludes} but got ${request.url}`);
    }
    return { status: next.status, body: next.body, headers: {} };
  };
}

const tiktokCredentials = { accessToken: "token", advertiserId: "adv" };
const tiktokInput = {
  name: "North",
  dailyBudget: 20,
  locationIds: ["6252001"],
  scheduleStart: "2026-01-02 00:00:00",
  landingPageUrl: "https://example.com",
  adText: "Open the bar",
  imageIds: ["img-1"],
};

test("tiktok publishing stores each confirmed id and a retry reuses every stage", async () => {
  const created = await publishTikTokFlow(
    tiktokCredentials,
    tiktokInput,
    scripted([
      { urlIncludes: "/campaign/create/", status: 200, body: JSON.stringify({ code: 0, data: { campaign_id: "c1" } }) },
      { urlIncludes: "/adgroup/create/", status: 200, body: JSON.stringify({ code: 0, data: { adgroup_id: "g1" } }) },
      { urlIncludes: "/ad/create/", status: 200, body: JSON.stringify({ code: 0, data: { creative_id: "cr1", ad_ids: ["a1"] } }) },
    ]),
  );
  assert.equal(created.campaign.externalId, "c1");
  assert.equal(created.ad_group.externalId, "g1");
  assert.equal(created.creative.status === "stored" && created.creative.externalId, "cr1");
  assert.equal(created.ad.status === "stored" && created.ad.externalId, "a1");
  let calls = 0;
  const retried = await publishTikTokFlow(
    tiktokCredentials,
    { ...tiktokInput, existing: { campaign: "c1", ad_group: "g1", creative: "cr1", ad: "a1" } },
    async () => {
      calls += 1;
      return { status: 500, body: "", headers: {} };
    },
  );
  assert.equal(calls, 0);
  assert.equal(retried.ad.status === "stored" && retried.ad.reused, true);
});

test("tiktok stops before the ad when the uploaded asset is missing", async () => {
  const urls: string[] = [];
  const result = await publishTikTokFlow(
    tiktokCredentials,
    { ...tiktokInput, imageIds: [], videoId: "" },
    async (request) => {
      urls.push(request.url);
      if (request.url.includes("campaign")) return { status: 200, body: JSON.stringify({ code: 0, data: { campaign_id: "c1" } }), headers: {} };
      return { status: 200, body: JSON.stringify({ code: 0, data: { adgroup_id: "g1" } }), headers: {} };
    },
  );
  assert.equal(result.creative.status, "EXTERNAL_CONNECTION_REQUIRED");
  assert.equal(urls.some((url) => url.includes("/ad/create/")), false);
});

test("tiktok does not store an id the response omitted", async () => {
  const result = await publishTikTokFlow(
    tiktokCredentials,
    tiktokInput,
    scripted([
      { status: 200, body: JSON.stringify({ code: 0, data: { campaign_id: "c1" } }) },
      { status: 200, body: JSON.stringify({ code: 0, data: { adgroup_id: "g1" } }) },
      { status: 200, body: JSON.stringify({ code: 0, data: {} }) },
    ]),
  );
  assert.equal(result.creative.status, "failed");
  assert.equal(confirmedExternalId(result.creative.status, result.creative.externalId), null);
  assert.equal(result.ad.externalId, null);
});

test("another workspace cannot reuse a stored external id", () => {
  assert.throws(
    () => reusableExternalId([{ organizationId: "a", idempotencyKey: "campaign", externalId: "c1" }], "b", "campaign"),
    /another workspace/,
  );
  assert.equal(reusableExternalId([{ organizationId: "a", idempotencyKey: "campaign", externalId: "c1" }], "a", "campaign"), "c1");
});

test("google resumes after a stored campaign and does not recreate it", async () => {
  const urls: string[] = [];
  const result = await publishGoogleFlow(
    { accessToken: "oauth", developerToken: "dev", customerId: "123" },
    {
      name: "North",
      dailyBudgetCents: 1000,
      cpcBidCents: 50,
      finalUrl: "https://example.com",
      headlines: ["Quiet soap"],
      descriptions: ["A short bar"],
      existing: { campaign: "customers/123/campaigns/9" },
    },
    async (request) => {
      urls.push(request.url);
      return { status: 200, body: JSON.stringify({ results: [{ resourceName: `${request.url.split("/").pop()}/1` }] }), headers: {} };
    },
  );
  assert.equal(urls.some((url) => url.includes("campaignBudgets")), false);
  assert.equal(urls.some((url) => url.includes("/campaigns:mutate")), false);
  assert.equal(result.ad_group.status, "stored");
  assert.equal(result.ad.status, "stored");
  assert.equal(confirmedExternalId(result.budget.status, result.budget.externalId), null);
});

test("google does not send an ad when the headline is too long", async () => {
  const urls: string[] = [];
  const result = await publishGoogleFlow(
    { accessToken: "oauth", developerToken: "dev", customerId: "123" },
    {
      name: "North",
      dailyBudgetCents: 1000,
      cpcBidCents: 50,
      finalUrl: "https://example.com",
      headlines: ["This headline is definitely longer than thirty"],
      descriptions: ["Fine"],
      existing: { budget: "customers/123/campaignBudgets/1", campaign: "customers/123/campaigns/1", ad_group: "customers/123/adGroups/1" },
    },
    async (request) => {
      urls.push(request.url);
      return { status: 200, body: "{}", headers: {} };
    },
  );
  assert.equal(urls.length, 0);
  assert.equal(result.ad.status, "failed");
});

test("meta insights do not turn a missing count into zero and do not double-learn a duplicate", () => {
  const event = metaInsightEvent({
    row: { impressions: "1000", clicks: "40", spend: "12.50", date_start: "2026-01-02" },
    creativeId: "creative",
    externalId: "ad:1",
    currency: "USD",
    timezone: "UTC",
  });
  assert.equal(event.spendCents, 1250);
  assert.equal(event.revenueCents, null);
  const first = ingestPerformanceRows([], [event]);
  assert.equal(first.stored.length, 1);
  const second = ingestPerformanceRows(first.stored, [event]);
  assert.equal(second.stored.length, 0);
  assert.equal(second.duplicates, 1);
  const missing = ingestPerformanceRows([], [{ ...event, externalId: "ad:2", impressions: null }]);
  assert.equal(missing.stored.length, 0);
});

test("unknown revenue does not become a zero-ROAS pattern", () => {
  const patterns = learnPatterns({
    organizationId: "org",
    brandId: "brand",
    creatives: [
      { id: "c1", organizationId: "org", brandId: "brand", origin: "generated", angle: "quiet", hookType: "demo", format: "image", proofType: "", offer: "", cta: "", visualStyle: "", platform: "", emotion: "", productName: "soap", claim: "", text: "" },
      { id: "c2", organizationId: "org", brandId: "brand", origin: "generated", angle: "quiet", hookType: "demo", format: "image", proofType: "", offer: "", cta: "", visualStyle: "", platform: "", emotion: "", productName: "soap", claim: "", text: "" },
      { id: "c3", organizationId: "org", brandId: "brand", origin: "generated", angle: "quiet", hookType: "demo", format: "image", proofType: "", offer: "", cta: "", visualStyle: "", platform: "", emotion: "", productName: "soap", claim: "", text: "" },
    ],
    observations: [
      { creativeId: "c1", organizationId: "org", brandId: "brand", impressions: 400, clicks: 40, conversions: 4, spendCents: 1000, revenueCents: null },
      { creativeId: "c2", organizationId: "org", brandId: "brand", impressions: 400, clicks: 20, conversions: 1, spendCents: 1000, revenueCents: null },
      { creativeId: "c3", organizationId: "org", brandId: "brand", impressions: 400, clicks: 10, conversions: 0, spendCents: 1000, revenueCents: null },
    ],
  });
  assert.equal(patterns.some((pattern) => pattern.metric === "roas"), false);
});

test("performance sync is scheduled only for a healthy implemented provider", () => {
  assert.equal(performanceScheduleDecision({ provider: "meta", phase: "HEALTHY", disconnected: false }).enabled, true);
  assert.equal(performanceScheduleDecision({ provider: "tiktok", phase: "HEALTHY", disconnected: false }).enabled, true);
  assert.equal(performanceScheduleDecision({ provider: "google", phase: "CONNECTED", disconnected: false }).enabled, true);
  assert.equal(performanceScheduleDecision({ provider: "meta", phase: "HEALTHY", disconnected: true }).enabled, false);
  assert.equal(performanceScheduleDecision({ provider: "tiktok", phase: "NOT_CONFIGURED", disconnected: false }).enabled, false);
  assert.equal(performanceScheduleDecision({ provider: "ad_library", phase: "HEALTHY", disconnected: false }).enabled, false);
});

test("oauth state must match and a token is sealed instead of returned in a URL", () => {
  const state = "abc123state";
  const hash = hashOauthState(state);
  assert.equal(oauthStateMatches(hash, state), true);
  assert.equal(oauthStateMatches(hash, "other"), false);
  const url = authorizationUrl("meta", { state, redirectUri: "https://example.com/api/oauth/callback", env: { META_APP_ID: "app" } });
  assert.equal("url" in url, true);
  if ("url" in url) assert.equal(url.url.includes("client_secret"), false);
  const sealed = sealSecret("secret-token", "key");
  assert.equal(typeof sealed, "string");
  if (typeof sealed === "string") {
    assert.equal(sealed.includes("secret-token"), false);
    const opened = openSecret(sealed, "key");
    assert.equal(opened, "secret-token");
  }
  const empty = sealSecret("secret-token", "");
  assert.equal(typeof empty !== "string" && empty.error.length > 0, true);
});

test("oauth exchange stores nothing when the provider omits the token", async () => {
  const result = await exchangeOauthCode("google", { code: "code", redirectUri: "https://example.com/cb", env: {} }, async () => ({
    status: 200,
    body: JSON.stringify({ token_type: "Bearer" }),
    headers: {},
  }));
  assert.equal("error" in result, true);
});

test("webhooks reject a bad signature, a replay, a duplicate, and an unknown account", () => {
  const body = JSON.stringify({ hello: "north" });
  const timestamp = "100000";
  const signature = signWebhookBody("secret", timestamp, body);
  const now = 100000;
  assert.equal(verifyWebhook({ secret: "secret", timestamp, signature, rawBody: body, eventId: "e1", nowMs: now, seenEventIds: [], accountKnown: true }).status, "accepted");
  assert.equal(verifyWebhook({ secret: "secret", timestamp, signature: "nope", rawBody: body, eventId: "e1", nowMs: now, seenEventIds: [], accountKnown: true }).status, "rejected");
  assert.equal(reason(verifyWebhook({ secret: "secret", timestamp: "1", signature, rawBody: body, eventId: "e1", nowMs: 500000, seenEventIds: [], accountKnown: true })), "The webhook timestamp is outside the replay window.");
  assert.equal(reason(verifyWebhook({ secret: "secret", timestamp, signature, rawBody: body, eventId: "e1", nowMs: now, seenEventIds: ["e1"], accountKnown: true })), "This event id was already stored.");
  assert.equal(reason(verifyWebhook({ secret: "secret", timestamp, signature, rawBody: body, eventId: "e1", nowMs: now, seenEventIds: [], accountKnown: false })), "The account on the webhook is not connected to a workspace.");
  const broken = "{";
  assert.equal(reason(verifyWebhook({ secret: "secret", timestamp, signature: signWebhookBody("secret", timestamp, broken), rawBody: broken, eventId: "e1", nowMs: now, seenEventIds: [], accountKnown: true })), "The payload is not JSON.");
});

function reason(decision: ReturnType<typeof verifyWebhook>): string {
  return decision.status === "rejected" ? decision.reason : decision.status;
}

test("alerts dedupe and do not claim delivery without a target", async () => {
  const first = dedupeAlert([], { id: "1", organizationId: "org", code: "worker.stopped", severity: "critical", detail: "down", lastSeen: "t1" });
  const second = dedupeAlert(first, { id: "2", organizationId: "org", code: "worker.stopped", severity: "critical", detail: "still down", lastSeen: "t2" });
  assert.equal(second.length, 1);
  assert.equal(second[0]?.lastSeen, "t2");
  const delivery = await deliverAlert(second[0]!, { kind: "none" }, async () => {
    throw new Error("should not send");
  });
  assert.equal(delivery.status, "NOT_CONFIGURED");
});

test("an approved threshold is what ranking will read, and code defaults remain without one", () => {
  const fallback = { autoApprove: 0.8, humanReview: 0.4, minConfidenceForAuto: 0.5 };
  assert.equal(approvedThresholds(fallback, null).source, "code");
  const proposal = proposeThresholdChange({
    questionId: "opportunity_gate",
    current: { autoApprove: 0.8, humanReview: 0.4 },
    rows: Array.from({ length: 40 }, (_, index) => ({ probability: index < 20 ? 0.9 : 0.2, reviewerApproved: index < 20 })),
  });
  assert.equal(proposal.status, "proposed");
  if (proposal.proposal) {
    const approved = approveThresholdChange(proposal.proposal, "reviewer", 0);
    const active = approvedThresholds(fallback, { thresholds: JSON.stringify(approved.thresholds) });
    assert.equal(active.source, "approved");
    assert.equal(active.autoApprove, approved.thresholds.autoApprove);
  }
});

test("operation logs redact bearer tokens", () => {
  const record = operationRecord({
    correlationId: "c",
    provider: "meta",
    operation: "probe",
    organizationId: "org",
    brandId: "brand",
    durationMs: 10,
    ok: false,
    attempts: 1,
    detail: "Authorization: Bearer super-secret failed",
  });
  assert.equal(String(record.detail).includes("super-secret"), false);
  assert.equal(redactSecrets("access_token=abc").includes("abc"), false);
});
