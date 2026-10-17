import assert from "node:assert/strict";
import test from "node:test";
import type { Sql } from "../learning/store.ts";
import { sealSecret } from "../oauth/flow.server.ts";
import type { Transport, TransportRequest } from "../providers/http.ts";
import { runPerformanceSync } from "./job.ts";

// Metrics for TikTok and Google Ads are read only with the workspace's own sealed token. An environment token is never used.

const KEY = "tenant-token-key";

function fixture(sealed?: string) {
  const writes: string[] = [];
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("update provider_connections")) writes.push("not-connected");
    if (query.includes("from creative_records")) return [{ id: "creative-a", organization_id: "org-a", brand_id: "brand-a" }];
    if (query.includes("from provider_objects")) return [{ external_id: "ad-a", organization_id: "org-a", brand_id: "brand-a" }];
    if (query.includes("from provider_secrets")) return sealed ? [{ sealed_token: sealed }] : [];
    if (query.includes("from platform_accounts")) return [{ external_account_id: "acct-brand" }];
    return [];
  }) as unknown as Sql;
  const requests: TransportRequest[] = [];
  const transport: Transport = async (request) => {
    requests.push(request);
    return { status: 404, body: JSON.stringify({ error: { message: "unexpected request" } }), headers: {} };
  };
  return { sql, writes, requests, transport };
}

const job = { id: "job-1", organization_id: "org-a", brand_id: "brand-a" };

async function withEnv(values: Record<string, string>, fn: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const name of [...Object.keys(values), "TOKEN_ENCRYPTION_KEY"]) saved[name] = process.env[name];
  Object.assign(process.env, values);
  process.env.TOKEN_ENCRYPTION_KEY = KEY;
  try {
    await fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("TikTok sync with no tenant token records NOT_CONNECTED, makes no request, and ignores the environment token", async () => {
  await withEnv({ TIKTOK_ACCESS_TOKEN: "env-tiktok-token", TIKTOK_ADVERTISER_ID: "adv-1" }, async () => {
    const f = fixture();
    await assert.rejects(
      runPerformanceSync(f.sql, { ...job }, { provider: "tiktok", creativeId: "creative-a", externalAdId: "ad-a", currency: "USD", timezone: "UTC" }, f.transport),
      /NOT_CONNECTED/,
    );
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.writes, ["not-connected"]);
  });
});

test("Google Ads sync with no tenant token records NOT_CONNECTED, makes no request, and ignores the environment token", async () => {
  await withEnv({ GOOGLE_ADS_ACCESS_TOKEN: "env-google-token", GOOGLE_ADS_CUSTOMER_ID: "123" }, async () => {
    const f = fixture();
    await assert.rejects(
      runPerformanceSync(f.sql, { ...job }, { provider: "google", creativeId: "creative-a", externalAdId: "ad-a", currency: "USD", timezone: "UTC" }, f.transport),
      /NOT_CONNECTED/,
    );
    assert.equal(f.requests.length, 0);
  });
});

test("TikTok sync with a sealed tenant token sends only that token, never the environment token", async () => {
  await withEnv({ TIKTOK_ACCESS_TOKEN: "env-tiktok-token", TIKTOK_ADVERTISER_ID: "adv-env" }, async () => {
    const f = fixture(String(sealSecret("tenant-tiktok-token", KEY)));
    await assert.rejects(
      runPerformanceSync(
        f.sql,
        { ...job },
        { provider: "tiktok", creativeId: "creative-a", externalAdId: "ad-a", currency: "USD", timezone: "UTC", startDate: "2026-01-01", endDate: "2026-01-02" },
        f.transport,
      ),
    );
    assert.ok(f.requests.length >= 1, "the sealed token is used for the request");
    for (const request of f.requests) {
      assert.equal(request.headers["Access-Token"], "tenant-tiktok-token");
    }
    assert.equal(JSON.stringify(f.requests).includes("env-tiktok-token"), false);
    assert.equal(JSON.stringify(f.requests).includes("adv-env"), false, "the deployment advertiser id is not this brand's account");
    assert.equal(JSON.stringify(f.requests).includes("acct-brand"), true);
  });
});
