import assert from "node:assert/strict";
import test from "node:test";
import { resolveCredential, sharesDeploymentKey } from "./resolve.ts";
import { storeVaultCredential } from "../vault/service.ts";
import { fakeVaultSql, withEnv } from "../testing/fake-vault-sql.ts";
import { CREDENTIAL_VAULT_TYPE } from "./contract.ts";

const WORKSPACE_KEY = "workspace-typesafe-key-1234";
const DEPLOYMENT_KEY = "deployment-typesafe-key-9876";

test("credential resolver: a saved workspace key is used and only its fingerprint is exposed", async () => {
  await withEnv({ JEV_SHARED_DEFAULT: undefined }, async () => {
    const { sql } = fakeVaultSql();
    await storeVaultCredential(sql, "org-a", CREDENTIAL_VAULT_TYPE.jev, { accessToken: "", apiKey: WORKSPACE_KEY, customFields: {} });
    const resolution = await resolveCredential(sql, "org-a", "jev");
    assert.equal(resolution.status, "ready");
    assert.equal(resolution.status === "ready" && resolution.source, "workspace");
    assert.equal(resolution.status === "ready" && resolution.secret, WORKSPACE_KEY);
    assert.equal(resolution.status === "ready" && resolution.fingerprint, "...1234");
  });
});

test("credential resolver: a saved key belongs to its organization only", async () => {
  await withEnv({}, async () => {
    const { sql } = fakeVaultSql();
    await storeVaultCredential(sql, "org-a", CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: WORKSPACE_KEY, customFields: {} });
    const other = await resolveCredential(sql, "org-b", "production");
    assert.equal(other.status, "not_configured", "another tenant must not see this workspace's key");
  });
});

test("credential resolver: an expired saved key is unusable, and the deployment key is never used in its place", async () => {
  await withEnv({ JEV_SHARED_DEFAULT: "deployment", TYPESAFE_JEV_API_KEY: DEPLOYMENT_KEY }, async () => {
    const { sql, rows } = fakeVaultSql();
    await storeVaultCredential(sql, "org-x", CREDENTIAL_VAULT_TYPE.jev, { accessToken: "", apiKey: WORKSPACE_KEY, customFields: {} });
    rows[0].expires_at = "2020-01-01T00:00:00.000Z";
    const resolution = await resolveCredential(sql, "org-x", "jev");
    assert.equal(resolution.status, "unusable");
    assert.equal(resolution.status === "unusable" && resolution.source, "workspace");
    assert.equal(JSON.stringify(resolution).includes(DEPLOYMENT_KEY), false, "no fallback to the deployment key");
  });
});

test("credential resolver: an unreadable saved key is unusable, not a silent fallback", async () => {
  await withEnv({ PRODUCTION_SHARED_DEFAULT: "deployment", MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_KEY }, async () => {
    const { sql, rows } = fakeVaultSql();
    await storeVaultCredential(sql, "org-u", CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: WORKSPACE_KEY, customFields: {} });
    rows[0].ciphertext = "AAAA";
    const resolution = await resolveCredential(sql, "org-u", "production");
    assert.equal(resolution.status, "unusable");
    assert.equal(JSON.stringify(resolution).includes(DEPLOYMENT_KEY), false);
  });
});

test("credential resolver: a saved entry with no key, or a key too short to be real, is unusable", async () => {
  await withEnv({}, async () => {
    const { sql } = fakeVaultSql();
    await storeVaultCredential(sql, "org-empty", CREDENTIAL_VAULT_TYPE.jev, { accessToken: "", apiKey: "", customFields: {} });
    assert.equal((await resolveCredential(sql, "org-empty", "jev")).status, "unusable");

    await storeVaultCredential(sql, "org-short", CREDENTIAL_VAULT_TYPE.jev, { accessToken: "", apiKey: "abc", customFields: {} });
    const short = await resolveCredential(sql, "org-short", "jev");
    assert.equal(short.status, "unusable");
    assert.match(short.status === "unusable" ? short.reason : "", /too short/);
  });
});

test("credential resolver: with no saved entry and no opt-in, the deployment key is not used", async () => {
  await withEnv({ TYPESAFE_JEV_API_KEY: DEPLOYMENT_KEY }, async () => {
    const { sql } = fakeVaultSql();
    const resolution = await resolveCredential(sql, "org-none", "jev");
    assert.equal(resolution.status, "not_configured");
    assert.match(resolution.status === "not_configured" ? resolution.reason : "", /JEV_SHARED_DEFAULT=deployment/);
    assert.equal(JSON.stringify(resolution).includes(DEPLOYMENT_KEY), false);
  });
});

test("credential resolver: with the opt-in and no saved entry, the deployment key is the shared default", async () => {
  await withEnv({ JEV_SHARED_DEFAULT: "deployment", TYPESAFE_JEV_API_KEY: DEPLOYMENT_KEY }, async () => {
    const resolution = await resolveCredential(fakeVaultSql().sql, "org-shared", "jev");
    assert.equal(resolution.status, "ready");
    assert.equal(resolution.status === "ready" && resolution.source, "deployment_shared_default");
    assert.equal(resolution.status === "ready" && resolution.fingerprint, "...9876");
  });
});

test("credential resolver: the opt-in with no deployment key is not configured", async () => {
  await withEnv({ PRODUCTION_SHARED_DEFAULT: "deployment" }, async () => {
    const resolution = await resolveCredential(fakeVaultSql().sql, "org-empty-dep", "production");
    assert.equal(resolution.status, "not_configured");
    assert.match(resolution.status === "not_configured" ? resolution.reason : "", /no production key set/);
  });
});

test("credential resolver: the production deployment key is read under every accepted alias", async () => {
  for (const alias of ["MERIDIAN_GEMINI_API_KEY", "GOOGLE_AI_STUDIO_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
    await withEnv({ PRODUCTION_SHARED_DEFAULT: "deployment", [alias]: "gemini-alias-key-4321" }, async () => {
      const resolution = await resolveCredential(fakeVaultSql().sql, "org-alias", "production");
      assert.equal(resolution.status, "ready", `${alias} must be accepted`);
      assert.equal(resolution.status === "ready" && resolution.fingerprint, "...4321");
    });
  }
});

test("credential resolver: without a database connection the workspace cannot be read, so nothing is used", async () => {
  await withEnv({ JEV_SHARED_DEFAULT: "deployment", TYPESAFE_JEV_API_KEY: DEPLOYMENT_KEY }, async () => {
    const resolution = await resolveCredential(undefined, "org-nosql", "jev");
    assert.equal(resolution.status, "not_configured");
    assert.equal(JSON.stringify(resolution).includes(DEPLOYMENT_KEY), false);
  });
});

test("credential resolver: an empty organization id reads nothing", async () => {
  await withEnv({}, async () => {
    const resolution = await resolveCredential(fakeVaultSql().sql, "  ", "jev");
    assert.equal(resolution.status, "not_configured");
  });
});

test("credential resolver: the opt-in is read as an exact accepted value", async () => {
  await withEnv({ JEV_SHARED_DEFAULT: "yes" }, async () => {
    assert.equal(sharesDeploymentKey("jev"), false);
  });
  await withEnv({ JEV_SHARED_DEFAULT: " Deployment " }, async () => {
    assert.equal(sharesDeploymentKey("jev"), true);
  });
});
