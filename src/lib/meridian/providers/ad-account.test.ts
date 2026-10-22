import assert from "node:assert/strict";
import test from "node:test";
import type { Transport, TransportRequest } from "./http.ts";
import { AD_ACCOUNT_LABEL, AD_ACCOUNT_PLATFORM } from "./ad-account.ts";
import { publishPausedStages } from "./live.ts";

test("each publishing provider names one saved ad account platform and one label", () => {
  assert.deepEqual(AD_ACCOUNT_PLATFORM, { meta: "meta_ads", google: "google_ads", tiktok: "tiktok_ads" });
  assert.deepEqual(AD_ACCOUNT_LABEL, { meta: "Meta", google: "Google Ads", tiktok: "TikTok" });
});

test("a Google publish goes to the saved customer, and no environment customer id is read", async () => {
  const sent: TransportRequest[] = [];
  const transport: Transport = async (request) => {
    sent.push(request);
    return { status: 200, body: JSON.stringify({ results: [{ resourceName: "customers/777/campaignBudgets/1" }] }), headers: {} };
  };
  await publishPausedStages({
    provider: "google",
    name: "North",
    dailyBudgetCents: 1000,
    countries: ["US"],
    pageId: "",
    link: "https://example.com",
    message: "",
    accessToken: "oauth",
    adAccountId: "777",
    // The environment names a different customer. The saved account must win, and the variable is not read.
    env: { GOOGLE_ADS_DEVELOPER_TOKEN: "dev", GOOGLE_ADS_DEVELOPER_TOKEN_SHARED_DEFAULT: "deployment", GOOGLE_ADS_CUSTOMER_ID: "111" },
    transport,
  });
  assert.ok(sent.length > 0, "a Google publish sends a request");
  assert.ok(sent.every((request) => !request.url.includes("/customers/111/")), "the environment customer is never used");
  assert.ok(sent[0]?.url.includes("/customers/777/"), `the saved customer is used: ${sent[0]?.url}`);
});

test("a Meta publish with no saved account sends nothing", async () => {
  const sent: TransportRequest[] = [];
  const stages = await publishPausedStages({
    provider: "meta",
    name: "North",
    dailyBudgetCents: 1000,
    countries: ["US"],
    pageId: "page",
    link: "https://example.com",
    message: "Soap",
    accessToken: "token",
    transport: async (request) => {
      sent.push(request);
      return { status: 200, body: JSON.stringify({ id: "1" }), headers: {} };
    },
  });
  assert.equal(sent.length, 0, "nothing is sent without a saved account");
  assert.ok(stages.every((stage) => stage.status !== "stored"));
});
