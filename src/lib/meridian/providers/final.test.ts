import assert from "node:assert/strict";
import test from "node:test";
import { deliveryPlan, deliveryUrlAllowed } from "../alerts/lifecycle.ts";
import { calibrationVisible, proposalCreateDecision, reviewerRowsFromStored } from "../calibration/scope.ts";
import { buildBrief } from "../brief/engine.ts";
import type { BrainSlice, ObservedCreative, PerformanceRow } from "../domain.ts";
import { learnPatterns } from "../learning/engine.ts";
import { refreshOauthToken } from "../oauth/flow.server.ts";
import { rankOpportunities } from "../opportunity/engine.ts";
import { loadProviderInsights } from "../performance/fetch.ts";
import { shouldEnqueueLearning } from "../performance/job.ts";
import { planPerformanceSchedule } from "../performance/schedule.ts";
import { googleInsightEvent, ingestPerformanceRows, metaInsightEvent, tiktokInsightEvent } from "../performance/sync.ts";
import { publishPausedStages } from "./live.ts";
import { stageAuditRecord } from "./evidence.ts";
import { fetchGoogleInsights } from "./google-ads.ts";
import type { Transport } from "./http.ts";
import { fetchTikTokInsights, publishTikTokFlow } from "./tiktok.ts";
import { publishGoogleFlow } from "./google-ads.ts";
import { openAccessToken, stageWrites } from "./stages.ts";

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

test("tiktok retries reuse each stored stage and a failed ad group creates no ad", async () => {
  const campaignOnly: string[] = [];
  await publishTikTokFlow(
    tiktokCredentials,
    { ...tiktokInput, existing: { campaign: "c1" } },
    async (request) => {
      campaignOnly.push(request.url);
      if (request.url.includes("adgroup")) return { status: 200, body: JSON.stringify({ code: 0, data: { adgroup_id: "g1" } }), headers: {} };
      return { status: 200, body: JSON.stringify({ code: 0, data: { creative_id: "cr1", ad_ids: ["a1"] } }), headers: {} };
    },
  );
  assert.equal(campaignOnly.some((url) => url.includes("/campaign/create/")), false);
  const groupOnly: string[] = [];
  await publishTikTokFlow(
    tiktokCredentials,
    { ...tiktokInput, existing: { campaign: "c1", ad_group: "g1" } },
    async (request) => {
      groupOnly.push(request.url);
      return { status: 200, body: JSON.stringify({ code: 0, data: { creative_id: "cr1", ad_ids: ["a1"] } }), headers: {} };
    },
  );
  assert.equal(groupOnly.some((url) => url.includes("adgroup")), false);
  const creativeOnly: string[] = [];
  const reusedCreative = await publishTikTokFlow(
    tiktokCredentials,
    { ...tiktokInput, existing: { campaign: "c1", ad_group: "g1", creative: "cr1" } },
    async (request) => {
      creativeOnly.push(request.url);
      return { status: 200, body: JSON.stringify({ code: 0, data: { ad_ids: ["a1"] } }), headers: {} };
    },
  );
  assert.equal(creativeOnly.length, 0);
  assert.equal(reusedCreative.creative.status === "stored" && reusedCreative.creative.reused, true);
  assert.equal(reusedCreative.ad.status, "failed");
  const adOnly = await publishTikTokFlow(
    tiktokCredentials,
    { ...tiktokInput, existing: { campaign: "c1", ad_group: "g1", ad: "a1" } },
    async () => {
      throw new Error("should not send");
    },
  );
  assert.equal(adOnly.ad.status === "stored" && adOnly.ad.reused, true);
  assert.equal(adOnly.creative.externalId, null);
  const stopped: string[] = [];
  const failed = await publishTikTokFlow(
    tiktokCredentials,
    tiktokInput,
    async (request) => {
      stopped.push(request.url);
      if (request.url.includes("campaign")) return { status: 200, body: JSON.stringify({ code: 0, data: { campaign_id: "c1" } }), headers: {} };
      return { status: 200, body: JSON.stringify({ code: 400, message: "no group" }), headers: {} };
    },
  );
  assert.equal(failed.ad_group.status, "failed");
  assert.equal(stopped.some((url) => url.includes("/ad/create/")), false);
  assert.equal(stageAuditRecord({ status: "failed", externalId: null, responseText: "access_token=secret" }).persist, false);
});

test("google failure stops downstream objects and a full retry reuses every stored resource", async () => {
  const urls: string[] = [];
  const failed = await publishGoogleFlow(
    { accessToken: "oauth", developerToken: "dev", customerId: "123" },
    {
      name: "North",
      dailyBudgetCents: 1000,
      cpcBidCents: 50,
      finalUrl: "https://example.com",
      headlines: ["Quiet soap"],
      descriptions: ["A short bar"],
    },
    async (request) => {
      urls.push(request.url);
      if (request.url.includes("campaignBudgets")) return { status: 200, body: JSON.stringify({ results: [{ resourceName: "customers/123/campaignBudgets/1" }] }), headers: {} };
      return { status: 400, body: "{}", headers: {} };
    },
  );
  assert.equal(failed.campaign.status, "failed");
  assert.equal(urls.some((url) => url.includes("adGroups")), false);
  let calls = 0;
  const reused = await publishGoogleFlow(
    { accessToken: "oauth", developerToken: "dev", customerId: "123" },
    {
      name: "North",
      dailyBudgetCents: 1000,
      cpcBidCents: 50,
      finalUrl: "https://example.com",
      headlines: ["Quiet soap"],
      descriptions: ["A short bar"],
      existing: {
        budget: "customers/123/campaignBudgets/1",
        campaign: "customers/123/campaigns/1",
        ad_group: "customers/123/adGroups/1",
        ad: "customers/123/adGroupAds/1~1",
      },
    },
    async () => {
      calls += 1;
      return { status: 500, body: "", headers: {} };
    },
  );
  assert.equal(calls, 0);
  assert.equal(reused.ad.status === "stored" && reused.ad.reused, true);
  assert.equal(stageAuditRecord({ status: "stored", externalId: "customers/123/campaigns/1", responseText: "Bearer secret-token" }).persist, true);
});

test("tiktok and google insight clients reject a missing metric and do not invent revenue", async () => {
  const tiktok = await fetchTikTokInsights(
    tiktokCredentials,
    { adId: "ad1", startDate: "2026-01-01", endDate: "2026-01-02" },
    async () => ({ status: 200, body: JSON.stringify({ code: 0, data: { list: [{ dimensions: { stat_time_day: "2026-01-02" }, metrics: { impressions: "100", clicks: "4", spend: "1.25" } }] } }), headers: {} }),
  );
  assert.equal(tiktok.ok, true);
  const event = tiktokInsightEvent({ row: tiktok.rows[0]!, creativeId: "c1", externalId: "ad1:0", currency: "USD", timezone: "UTC" });
  assert.equal(event.spendCents, 125);
  assert.equal(event.revenueCents, null);
  const missing = ingestPerformanceRows([], [{ ...event, impressions: null }]);
  assert.equal(missing.stored.length, 0);
  const google = googleInsightEvent({
    row: { segments: { date: "2026-01-02" }, metrics: { impressions: "10", clicks: "1", costMicros: "250000" } },
    creativeId: "c1",
    externalId: "ad:0",
    currency: "USD",
    timezone: "UTC",
  });
  assert.equal(google.spendCents, 25);
  const blocked = await fetchGoogleInsights(
    { accessToken: "oauth", developerToken: "dev", customerId: "123" },
    { adResourceName: "customers/999/adGroupAds/1~1", startDate: "2026-01-01", endDate: "2026-01-02" },
    async () => {
      throw new Error("should not send");
    },
  );
  assert.equal(blocked.ok, false);
});

test("a provider insight becomes one observation, changes rank and the next brief, and a duplicate does not learn again", () => {
  const org = "org";
  const brand = "brand";
  const brain: BrainSlice = {
    positioning: "A direct offer for people comparing price. Save. Deal. Offer.",
    differentiators: "",
    problems: "",
    desires: "",
    objections: "",
    tone: "",
    wordsToAvoid: "",
    preferredFormats: "",
    prohibitedClaims: "cures eczema",
    requiredDisclaimers: "",
    targetCustomers: "people who already buy the category",
    valueProposition: "A clear price.",
  };
  const creatives: ObservedCreative[] = ["curiosity", "offer"].flatMap((angle) =>
    [0, 1, 2].map((index) => ({
      id: `${angle}-${index}`,
      organizationId: org,
      brandId: brand,
      origin: "generated" as const,
      angle,
      hookType: angle,
      format: "image",
      proofType: "",
      offer: "",
      cta: "",
      visualStyle: "",
      platform: "",
      emotion: "",
      productName: "soap",
      claim: "",
      text: angle,
    })),
  );
  const events = creatives.map((creative) =>
    metaInsightEvent({
      row: {
        impressions: "400",
        clicks: creative.angle === "curiosity" ? "40" : "8",
        spend: "10.00",
        date_start: "2026-01-02",
        actions: [{ action_type: "offsite_conversion", value: creative.angle === "curiosity" ? "4" : "0" }],
      },
      creativeId: creative.id,
      externalId: creative.id,
      currency: "USD",
      timezone: "UTC",
    }),
  );
  const first = ingestPerformanceRows([], events);
  assert.equal(first.stored.length, creatives.length);
  assert.equal(shouldEnqueueLearning(first.stored.length), true);
  const duplicate = ingestPerformanceRows(first.stored, events);
  assert.equal(duplicate.stored.length, 0);
  assert.equal(shouldEnqueueLearning(duplicate.stored.length), false);
  const observations: PerformanceRow[] = first.stored.map((event) => ({
    creativeId: event.creativeId,
    organizationId: org,
    brandId: brand,
    impressions: event.impressions ?? 0,
    clicks: event.clicks ?? 0,
    conversions: event.conversions ?? 0,
    spendCents: event.spendCents ?? 0,
    revenueCents: event.revenueCents,
  }));
  const before = rankOpportunities({ organizationId: org, brandId: brand, brain, products: [{ id: "p", name: "soap", description: "", allowedClaims: "", prohibitedClaims: "" }], creatives, patterns: [], rejections: [] });
  const patterns = learnPatterns({ organizationId: org, brandId: brand, creatives, observations });
  const negative = patterns.find((pattern) => pattern.value === "offer" && pattern.lift < 0);
  assert.ok(negative);
  const after = rankOpportunities({ organizationId: org, brandId: brand, brain, products: [{ id: "p", name: "soap", description: "", allowedClaims: "", prohibitedClaims: "" }], creatives, patterns, rejections: [] });
  const rank = (drafts: typeof before, id: string) => drafts.findIndex((draft) => draft.hypothesisId === id);
  assert.ok(rank(after, "curiosity") < rank(before, "curiosity") || rank(after, "curiosity") <= rank(after, "offer"));
  const offer = after.find((draft) => draft.angle === "offer") ?? after[0];
  assert.ok(offer);
  const brief = buildBrief({
    opportunity: offer,
    brain,
    patterns,
    rejections: [{ reasonCode: "off_brand", count: 2 }],
  });
  assert.ok(brief.constraints.includes("Do not prefer") || brief.learningNotes.length > 0);
  assert.ok(brief.failureNotes.some((note) => note.includes("off_brand")) || brief.constraints.includes("off_brand"));
  assert.throws(
    () => learnPatterns({ organizationId: org, brandId: brand, creatives, observations: observations.map((row) => ({ ...row, brandId: "other" })) }),
    /Tenant scope/,
  );
  const thin = learnPatterns({
    organizationId: org,
    brandId: brand,
    creatives: creatives.slice(0, 2),
    observations: observations.slice(0, 2),
  });
  assert.equal(thin.length, 0);
});

test("performance schedules do not duplicate and stay off until the provider is healthy", () => {
  const base = {
    organizationId: "org",
    brandId: "brand",
    provider: "tiktok",
    phase: "HEALTHY" as const,
    disconnected: false,
    everySeconds: 3600,
    creativeId: "c1",
    externalAdId: "ad1",
    currency: "USD",
    timezone: "UTC",
    startDate: "2026-01-01",
    endDate: "2026-01-07",
  };
  const first = planPerformanceSchedule(base);
  const second = planPerformanceSchedule(base);
  assert.ok(!("error" in first) && !("error" in second));
  if (!("error" in first) && !("error" in second)) assert.equal(first.id, second.id);
  const down = planPerformanceSchedule({ ...base, disconnected: true });
  assert.ok(!("error" in down) && down.enabled === false);
  assert.ok("error" in planPerformanceSchedule({ ...base, everySeconds: 10 }));
});

test("oauth refresh stores nothing when the provider omits the access token", async () => {
  const missing = await refreshOauthToken("google", { refreshToken: "refresh", env: {} }, async () => ({
    status: 200,
    body: JSON.stringify({ token_type: "Bearer" }),
    headers: {},
  }));
  assert.equal("error" in missing, true);
  const empty = await refreshOauthToken("meta", { refreshToken: "", env: {} }, async () => {
    throw new Error("should not send");
  });
  assert.equal("error" in empty, true);
});

test("alerts do not page an unapproved url and dead-letter after repeated failure", () => {
  assert.equal(deliveryUrlAllowed("http://169.254.169.254/latest"), false);
  assert.equal(deliveryUrlAllowed("https://alerts.example.com/hook"), true);
  const dead = deliveryPlan([{ status: "failed" }, { status: "failed" }, { status: "failed" }], { kind: "webhook", url: "https://alerts.example.com/hook" });
  assert.equal(dead.action, "dead");
  const none = deliveryPlan([], { kind: "none" });
  assert.equal(none.status, "NOT_CONFIGURED");
});

test("calibration proposals stay inside the workspace and do not open twice", () => {
  assert.equal(calibrationVisible({ organizationId: "a", brandId: "b" }, { organizationId: "a", brandId: "b" }), true);
  assert.equal(calibrationVisible({ organizationId: "a", brandId: "b" }, { organizationId: "c", brandId: "b" }), false);
  assert.equal(proposalCreateDecision(["proposed"]), "already_open");
  assert.equal(proposalCreateDecision(["rejected"]), "create");
  const rows = reviewerRowsFromStored([
    { probability: 0.9, reviewerDecision: "approve" },
    { probability: 0.2, reviewerDecision: "reject" },
    { probability: 0.5, reviewerDecision: null },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.reviewerApproved, true);
});

test("a sealed token that cannot be opened does not fall through to the environment token", () => {
  const blocked = openAccessToken({ sealed: "not-a-token", key: "", envToken: "env-secret" });
  assert.equal("token" in blocked, false);
  const plain = openAccessToken({ sealed: "", key: "", envToken: "env-secret" });
  assert.equal("token" in plain && plain.source, "environment");
  assert.throws(
    () => stageWrites({
      organizationId: "b",
      brandId: "brand",
      creativeId: "creative",
      existing: [{ organizationId: "a", idempotencyKey: "brand:creative:campaign", externalId: "c1" }],
      stages: [{ objectType: "campaign", status: "stored", externalId: "c1", responseText: "" }],
    }),
    /another workspace/,
  );
  const kept = stageWrites({
    organizationId: "a",
    brandId: "brand",
    creativeId: "creative",
    existing: [{ organizationId: "a", idempotencyKey: "brand:creative:campaign", externalId: "c1" }],
    stages: [{ objectType: "campaign", status: "stored", externalId: "c2", responseText: "access_token=secret" }],
  });
  assert.equal(kept[0]?.action, "keep");
  assert.equal(kept[0]?.externalId, "c1");
  assert.equal(kept[0]?.responseText.includes("secret"), false);
  const blank = stageWrites({
    organizationId: "a",
    brandId: "brand",
    creativeId: "creative",
    existing: [],
    stages: [{ objectType: "budget", status: "stored", externalId: "", responseText: "" }],
  });
  assert.equal(blank.length, 0);
});

test("tiktok paused publish creates a disabled campaign and does not invent a later id", async () => {
  let campaignBody = "";
  const stages = await publishPausedStages({
    provider: "tiktok",
    name: "North",
    dailyBudgetCents: 2000,
    countries: [],
    locationIds: ["6252001"],
    pageId: "",
    link: "https://example.com",
    message: "Open the bar",
    scheduleStart: "2026-01-02 00:00:00",
    imageIds: ["img-1"],
    env: { TIKTOK_ACCESS_TOKEN: "token", TIKTOK_ADVERTISER_ID: "adv" },
    transport: async (request) => {
      if (request.url.includes("/campaign/create/")) campaignBody = request.body ?? "";
      if (request.url.includes("/campaign/create/")) return { status: 200, body: JSON.stringify({ code: 0, data: { campaign_id: "c1" } }), headers: {} };
      if (request.url.includes("/adgroup/create/")) return { status: 200, body: JSON.stringify({ code: 0, data: { adgroup_id: "g1" } }), headers: {} };
      return { status: 200, body: JSON.stringify({ code: 0, data: {} }), headers: {} };
    },
  });
  assert.match(campaignBody, /DISABLE/);
  assert.equal(stages.find((stage) => stage.objectType === "campaign")?.externalId, "c1");
  assert.equal(stages.find((stage) => stage.objectType === "creative")?.externalId, null);
  assert.equal(stages.find((stage) => stage.objectType === "ad")?.externalId, null);
});

test("insight loading without a token stores nothing", async () => {
  const loaded = await loadProviderInsights(
    {
      provider: "tiktok",
      externalAdId: "ad1",
      creativeId: "c1",
      currency: "USD",
      timezone: "UTC",
      startDate: "2026-01-01",
      endDate: "2026-01-02",
      env: {},
    },
    (async () => {
      throw new Error("should not send");
    }) as Transport,
  );
  assert.equal("error" in loaded, true);
});
