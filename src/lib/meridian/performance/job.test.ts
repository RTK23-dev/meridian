import assert from "node:assert/strict";
import test from "node:test";
import type { Sql } from "../learning/store.ts";
import { sealSecret } from "../oauth/flow.server.ts";
import type { Transport, TransportRequest } from "../providers/http.ts";
import { runPerformanceSync } from "./job.ts";

function fixture(options: { sealed?: string; creativeBrand?: string; adBrand?: string } = {}) {
  const writes: string[] = [];
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("insert into performance_observations")) writes.push("observation");
    if (query.includes("insert into jobs")) writes.push(query.includes("learning.update") ? "learning" : "recommendation");
    if (query.includes("update provider_connections")) writes.push("not-connected");
    if (query.includes("from creative_records")) return [{ id: "creative-a", organization_id: "org-a", brand_id: options.creativeBrand ?? "brand-a" }];
    if (query.includes("from provider_objects")) return [{ external_id: "ad-a", organization_id: "org-a", brand_id: options.adBrand ?? "brand-a" }];
    if (query.includes("from provider_secrets")) return options.sealed ? [{ sealed_token: options.sealed }] : [];
    if (query.includes("from performance_observations")) return [];
    return [];
  }) as Sql;
  const requests: TransportRequest[] = [];
  const transport: Transport = async (request) => {
    requests.push(request);
    if (request.url.includes("/ad-a?fields=account_id")) return { status: 200, body: JSON.stringify({ account_id: "123" }), headers: {} };
    if (request.url.includes("/me/adaccounts")) return { status: 200, body: JSON.stringify({ data: [{ id: "act_123" }] }), headers: {} };
    if (request.url.includes("/ad-a/insights")) {
      return { status: 200, body: JSON.stringify({ data: [{ impressions: "10", clicks: "2", spend: "1.00", date_start: "2026-10-01" }] }), headers: {} };
    }
    return { status: 404, body: JSON.stringify({ error: { message: "unexpected request" } }), headers: {} };
  };
  return { sql, writes, requests, transport };
}

const job = { id: "job-1", organization_id: "org-a", brand_id: "brand-a" };
const payload = { provider: "meta", creativeId: "creative-a", externalAdId: "ad-a", currency: "USD", timezone: "UTC" };

test("worker revalidates creative and provider-ad tenant ownership before any provider request", async () => {
  const f = fixture({ sealed: String(sealSecret("tenant-a-token", "key")), adBrand: "brand-b" });
  await assert.rejects(runPerformanceSync(f.sql, job, payload, f.transport), /provider ad does not belong/);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.writes, []);
});

test("Meta worker uses only the job organization's sealed token and queues learning from fetched observations", async () => {
  const sealedA = sealSecret("tenant-a-token", "key");
  assert.equal(typeof sealedA, "string");
  const f = fixture({ sealed: sealedA as string });
  const prior = process.env.META_ACCESS_TOKEN;
  const priorKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.META_ACCESS_TOKEN = "tenant-b-global-token";
  process.env.TOKEN_ENCRYPTION_KEY = "key";
  try {
    const result = await runPerformanceSync(f.sql, job, payload, f.transport);
    assert.match(result, /^stored:1;/);
    assert.ok(f.requests.length >= 3);
    assert.ok(f.requests.every((request) => request.headers.Authorization === "Bearer tenant-a-token"));
    assert.deepEqual(f.writes, ["observation", "learning", "recommendation"]);
  } finally {
    if (prior === undefined) delete process.env.META_ACCESS_TOKEN;
    else process.env.META_ACCESS_TOKEN = prior;
    if (priorKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = priorKey;
  }
});

test("missing tenant Meta credentials produce NOT_CONNECTED without a provider request", async () => {
  const f = fixture();
  await assert.rejects(runPerformanceSync(f.sql, job, payload, f.transport), /NOT_CONNECTED/);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.writes, ["not-connected"]);
});
