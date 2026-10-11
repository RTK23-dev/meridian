import assert from "node:assert/strict";
import test, { after } from "node:test";
import { resolveCredential, resolveDeploymentOnlyKey } from "./resolve.ts";
import { CREDENTIAL_VAULT_TYPE, type CredentialResolution } from "./contract.ts";
import { openTestBackends, withEnv } from "./test-databases.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { storeVaultCredential } from "../vault/service.ts";

// Used only by this test process: the vault encrypts saved keys with this master key.
process.env.TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-provider-keys";

const backends = await openTestBackends();
after(async () => {
  for (const backend of backends) await backend.close();
});

// Every key here is a stub value. No test in this file calls a live provider.
const WORKSPACE_OPENAI = "workspace-openai-key-1111";
const DEPLOYMENT_OPENAI = "deployment-openai-key-2222";
const DEPLOYMENT_GEMINI = "deployment-gemini-key-3333";
const DEPLOYMENT_HYPIT_TOKEN = "deployment-hypit-token-4444";
const DEPLOYMENT_HYPIT_LEGACY = "deployment-hypit-legacy-5555";
const WORKSPACE_HYPIT = "workspace-hypit-key-6666";
const DEPLOYMENT_OPENROUTER = "deployment-openrouter-key-7777";

/** A resolution's reason text, or "" for a ready one. A ready resolution's secret must never appear in reason text. */
function reasonOf(resolution: CredentialResolution): string {
  return resolution.status === "ready" ? "" : resolution.reason;
}

for (const { name, sql } of backends) {
  test(`[${name}] OpenAI: a workspace key is used first, even when a deployment key is also set`, async () => {
    const tenant = await studioTenant(sql, `openai-ws-${name}`);
    await storeVaultCredential(sql, tenant.organizationId, CREDENTIAL_VAULT_TYPE.openai, { accessToken: "", apiKey: WORKSPACE_OPENAI });
    await withEnv({ OPENAI_SHARED_DEFAULT: "deployment", OPENAI_API_KEY: DEPLOYMENT_OPENAI }, async () => {
      const resolution = await resolveCredential(sql, tenant.organizationId, "openai");
      assert.equal(resolution.status, "ready");
      if (resolution.status === "ready") {
        assert.equal(resolution.source, "workspace");
        assert.equal(resolution.secret, WORKSPACE_OPENAI);
      }
    });
  });

  test(`[${name}] OpenAI: without OPENAI_SHARED_DEFAULT=deployment the deployment key is never used`, async () => {
    const tenant = await studioTenant(sql, `openai-noopt-${name}`);
    await withEnv({ OPENAI_API_KEY: DEPLOYMENT_OPENAI }, async () => {
      const resolution = await resolveCredential(sql, tenant.organizationId, "openai");
      assert.equal(resolution.status, "not_configured");
      assert.equal(JSON.stringify(resolution).includes(DEPLOYMENT_OPENAI), false);
      assert.match(reasonOf(resolution), /OPENAI_SHARED_DEFAULT=deployment/);
    });
  });

  test(`[${name}] OpenAI: with the opt-in, the deployment key is used when no workspace entry exists`, async () => {
    const tenant = await studioTenant(sql, `openai-opt-${name}`);
    await withEnv({ OPENAI_SHARED_DEFAULT: "deployment", OPENAI_API_KEY: DEPLOYMENT_OPENAI }, async () => {
      const resolution = await resolveCredential(sql, tenant.organizationId, "openai");
      assert.equal(resolution.status, "ready");
      if (resolution.status === "ready") {
        assert.equal(resolution.source, "deployment_shared_default");
        assert.equal(resolution.secret, DEPLOYMENT_OPENAI);
      }
    });
  });

  test(`[${name}] OpenAI: a deployment that opted in but has no OpenAI key does not borrow the Gemini key`, async () => {
    const tenant = await studioTenant(sql, `openai-noborrow-${name}`);
    await withEnv({ OPENAI_SHARED_DEFAULT: "deployment", MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_GEMINI }, async () => {
      const resolution = await resolveCredential(sql, tenant.organizationId, "openai");
      assert.equal(resolution.status, "not_configured");
      assert.equal(JSON.stringify(resolution).includes(DEPLOYMENT_GEMINI), false, "the Gemini key is never returned for OpenAI");
    });
  });

  test(`[${name}] OpenAI: an expired saved entry is unusable and never falls back to the deployment key`, async () => {
    const tenant = await studioTenant(sql, `openai-expired-${name}`);
    await storeVaultCredential(sql, tenant.organizationId, CREDENTIAL_VAULT_TYPE.openai, { accessToken: "", apiKey: WORKSPACE_OPENAI }, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    await withEnv({ OPENAI_SHARED_DEFAULT: "deployment", OPENAI_API_KEY: DEPLOYMENT_OPENAI }, async () => {
      const resolution = await resolveCredential(sql, tenant.organizationId, "openai");
      assert.equal(resolution.status, "unusable");
      assert.equal(JSON.stringify(resolution).includes(DEPLOYMENT_OPENAI), false);
    });
  });

  test(`[${name}] Hypit: a workspace key is used first, and the deployment token needs HYPIT_SHARED_DEFAULT=deployment`, async () => {
    const tenant = await studioTenant(sql, `hypit-${name}`);
    await withEnv({ HYPIT_API_TOKEN: DEPLOYMENT_HYPIT_TOKEN }, async () => {
      const without = await resolveCredential(sql, tenant.organizationId, "hypit");
      assert.equal(without.status, "not_configured");
      assert.equal(JSON.stringify(without).includes(DEPLOYMENT_HYPIT_TOKEN), false);
    });
    await storeVaultCredential(sql, tenant.organizationId, CREDENTIAL_VAULT_TYPE.hypit, { accessToken: "", apiKey: WORKSPACE_HYPIT });
    await withEnv({ HYPIT_SHARED_DEFAULT: "deployment", HYPIT_API_TOKEN: DEPLOYMENT_HYPIT_TOKEN }, async () => {
      const resolution = await resolveCredential(sql, tenant.organizationId, "hypit");
      assert.equal(resolution.status === "ready" && resolution.secret, WORKSPACE_HYPIT, "the workspace key wins");
    });
  });

  test(`[${name}] Hypit: with the opt-in and no workspace entry, the token name wins over the legacy name`, async () => {
    const tenant = await studioTenant(sql, `hypit-names-${name}`);
    await withEnv({ HYPIT_SHARED_DEFAULT: "deployment", HYPIT_API_TOKEN: DEPLOYMENT_HYPIT_TOKEN, HYPIT_API_KEY: DEPLOYMENT_HYPIT_LEGACY }, async () => {
      const resolution = await resolveCredential(sql, tenant.organizationId, "hypit");
      assert.equal(resolution.status === "ready" && resolution.secret, DEPLOYMENT_HYPIT_TOKEN);
    });
    await withEnv({ HYPIT_SHARED_DEFAULT: "deployment", HYPIT_API_KEY: DEPLOYMENT_HYPIT_LEGACY }, async () => {
      const resolution = await resolveCredential(sql, tenant.organizationId, "hypit");
      assert.equal(resolution.status === "ready" && resolution.secret, DEPLOYMENT_HYPIT_LEGACY, "the legacy name is still read when the token name is absent");
    });
  });
}

test("the deployment-only OpenRouter chat key follows the same opt-in, and its opt-in reason names what is missing", () => {
  return withEnv({ OPENROUTER_API_KEY: DEPLOYMENT_OPENROUTER }, async () => {
    const resolution = resolveDeploymentOnlyKey("openrouter_chat", process.env);
    assert.equal(resolution.status, "not_configured");
    assert.equal(JSON.stringify(resolution).includes(DEPLOYMENT_OPENROUTER), false);
  });
});
