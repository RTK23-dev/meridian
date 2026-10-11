import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { saveWorkspaceProviderConfig, testWorkspaceProviderConnection, type ProviderCategory } from "./provider-config.ts";
import { openTestBackends, withEnv } from "../credentials/test-databases.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";

// Used only by this test process: the vault encrypts saved values with this master key.
process.env.TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-provider-connection";

const backends = await openTestBackends();
after(async () => {
  for (const backend of backends) await backend.close();
});

const SAVED_TOKEN = "meta-ad-library-token-5678";
const LIVE_NOT_CALLED = /not called/;

for (const { name, sql } of backends) {
  test(`[${name}] sources Test Connection is not READY when nothing is saved, and says the live provider was not called`, async () => {
    const tenant = await studioTenant(sql, `sources-none-${name}`);
    await withEnv({}, async () => {
      const result = await testWorkspaceProviderConnection(sql, { organizationId: tenant.organizationId, category: "sources" });
      assert.equal(result.status, "NOT_CONFIGURED");
      assert.notEqual(result.status, "READY");
      assert.match(result.message, LIVE_NOT_CALLED);
    });
  });

  test(`[${name}] sources Test Connection is READY only for a saved, readable Meta Ad Library token, and never claims a live call`, async () => {
    const tenant = await studioTenant(sql, `sources-saved-${name}`);
    await saveWorkspaceProviderConfig(sql, {
      organizationId: tenant.organizationId,
      actorId: tenant.userId,
      category: "sources",
      settings: { metaAdLibraryToken: SAVED_TOKEN, maxPages: 20 },
    });
    await withEnv({}, async () => {
      const result = await testWorkspaceProviderConnection(sql, { organizationId: tenant.organizationId, category: "sources" });
      assert.equal(result.status, "READY");
      assert.match(result.message, LIVE_NOT_CALLED);
      assert.equal(result.message.includes(SAVED_TOKEN), false, "the message never carries the token");
    });
  });

  test(`[${name}] a saved sources entry with no token is not READY`, async () => {
    const tenant = await studioTenant(sql, `sources-empty-${name}`);
    await saveWorkspaceProviderConfig(sql, {
      organizationId: tenant.organizationId,
      actorId: tenant.userId,
      category: "sources",
      settings: { maxPages: 10 },
    });
    await withEnv({}, async () => {
      const result = await testWorkspaceProviderConnection(sql, { organizationId: tenant.organizationId, category: "sources" });
      assert.equal(result.status, "NOT_CONFIGURED");
      assert.match(result.message, LIVE_NOT_CALLED);
    });
  });

  test(`[${name}] a deployment META_AD_LIBRARY_TOKEN alone does not make sources READY, and the message names the opt-in`, async () => {
    const tenant = await studioTenant(sql, `sources-env-${name}`);
    await withEnv({ META_AD_LIBRARY_TOKEN: "deployment-meta-token-9999" }, async () => {
      const result = await testWorkspaceProviderConnection(sql, { organizationId: tenant.organizationId, category: "sources" });
      assert.notEqual(result.status, "READY");
      assert.match(result.message, /META_AD_LIBRARY_SHARED_DEFAULT=deployment/, "the deployment key needs its opt-in");
      assert.equal(result.message.includes("deployment-meta-token-9999"), false);
    });
  });

  test(`[${name}] a deployment META_AD_LIBRARY_TOKEN is READY only with its opt-in, and the message says it is the shared default`, async () => {
    const tenant = await studioTenant(sql, `sources-shared-${name}`);
    await withEnv({ META_AD_LIBRARY_TOKEN: "deployment-meta-token-9999", META_AD_LIBRARY_SHARED_DEFAULT: "deployment" }, async () => {
      const result = await testWorkspaceProviderConnection(sql, { organizationId: tenant.organizationId, category: "sources" });
      assert.equal(result.status, "READY");
      assert.match(result.message, /shared/);
      assert.equal(result.message.includes("deployment-meta-token-9999"), false);
    });
  });

  test(`[${name}] a category this check does not know is an error, never READY`, async () => {
    const tenant = await studioTenant(sql, `unknown-category-${name}`);
    await withEnv({}, async () => {
      const result = await testWorkspaceProviderConnection(sql, {
        organizationId: tenant.organizationId,
        category: "not-a-category" as ProviderCategory,
      });
      assert.equal(result.status, "ERROR");
      assert.match(result.message, /Unknown provider category/);
    });
  });
}

test("the connection test has no unconditional READY fallback", () => {
  const source = readFileSync(fileURLToPath(new URL("./provider-config.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /configuration test verified/, "the old default READY message is gone");
  assert.doesNotMatch(source, /\/\/ Default readiness check/);
});
