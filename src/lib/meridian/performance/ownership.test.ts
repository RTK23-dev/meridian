import assert from "node:assert/strict";
import test from "node:test";
import type { Sql } from "../learning/store.ts";
import { sealSecret } from "../oauth/flow.server.ts";
import type { Transport } from "../providers/http.ts";
import { verifyMetaAdAccountAccess } from "../providers/meta.ts";
import { loadTenantMetaToken, validatePerformanceOwnership } from "./ownership.ts";

function ownershipSql(input: { creativeOrg?: string; creativeBrand?: string; adOrg?: string; adBrand?: string }) {
  return (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    if (query.includes("from creative_records")) {
      return input.creativeOrg === "missing" ? [] : [{ id: "creative-1", organization_id: input.creativeOrg ?? "org-a", brand_id: input.creativeBrand ?? "brand-a" }];
    }
    if (query.includes("from provider_objects")) {
      return input.adOrg === "missing" ? [] : [{ external_id: "ad-1", organization_id: input.adOrg ?? "org-a", brand_id: input.adBrand ?? "brand-a" }];
    }
    return [];
  }) as Sql;
}

test("performance ownership rejects a creative from another tenant or brand", async () => {
  assert.equal((await validatePerformanceOwnership(ownershipSql({ creativeOrg: "org-b" }), {
    organizationId: "org-a", brandId: "brand-a", creativeId: "creative-1", externalAdId: "ad-1", provider: "meta",
  })).ok, false);
  assert.equal((await validatePerformanceOwnership(ownershipSql({ creativeBrand: "brand-b" }), {
    organizationId: "org-a", brandId: "brand-a", creativeId: "creative-1", externalAdId: "ad-1", provider: "meta",
  })).ok, false);
});

test("performance ownership rejects a provider ad from another tenant or brand", async () => {
  assert.equal((await validatePerformanceOwnership(ownershipSql({ adOrg: "org-b" }), {
    organizationId: "org-a", brandId: "brand-a", creativeId: "creative-1", externalAdId: "ad-1", provider: "meta",
  })).ok, false);
  assert.equal((await validatePerformanceOwnership(ownershipSql({ adBrand: "brand-b" }), {
    organizationId: "org-a", brandId: "brand-a", creativeId: "creative-1", externalAdId: "ad-1", provider: "meta",
  })).ok, false);
});

test("tenant Meta token lookup only opens the requesting organization's credential", async () => {
  const tokenA = sealSecret("tenant-a-token", "encryption-key");
  const tokenB = sealSecret("tenant-b-token", "encryption-key");
  assert.equal(typeof tokenA, "string");
  assert.equal(typeof tokenB, "string");
  let requestedOrganization = "";
  const sql = (async (_strings: TemplateStringsArray, organizationId: string) => {
    requestedOrganization = organizationId;
    return [{ sealed_token: organizationId === "org-a" ? tokenA : tokenB }];
  }) as Sql;
  const resolved = await loadTenantMetaToken(sql, "org-a", "encryption-key");
  assert.deepEqual(resolved, { status: "connected", accessToken: "tenant-a-token" });
  assert.equal(requestedOrganization, "org-a");
  const missing = await loadTenantMetaToken((async () => []) as unknown as Sql, "org-a", "encryption-key");
  assert.equal(missing.status, "NOT_CONNECTED");
});

test("Meta performance access is confirmed against the tenant token's ad-account list", async () => {
  const calls: string[] = [];
  const transport: Transport = async (request) => {
    calls.push(request.url);
    assert.equal(request.headers.Authorization, "Bearer tenant-a-token");
    if (request.url.includes("/ad-1?fields=account_id")) {
      return { status: 200, body: JSON.stringify({ account_id: "123" }), headers: {} };
    }
    return { status: 200, body: JSON.stringify({ data: [{ id: "act_123" }] }), headers: {} };
  };
  assert.deepEqual(await verifyMetaAdAccountAccess("tenant-a-token", "ad-1", transport), { ok: true });
  assert.equal(calls.length, 2);
  const foreignAccount = await verifyMetaAdAccountAccess("tenant-a-token", "ad-1", async (request) => {
    if (request.url.includes("/ad-1?fields=account_id")) return { status: 200, body: JSON.stringify({ account_id: "456" }), headers: {} };
    return { status: 200, body: JSON.stringify({ data: [{ id: "act_123" }] }), headers: {} };
  });
  assert.equal(foreignAccount.ok, false);
});
