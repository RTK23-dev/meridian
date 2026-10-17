import assert from "node:assert/strict";
import test, { after } from "node:test";
import { resolveCredential, resolveDeploymentOnlyKey, sharedDefaultOptedIn } from "./resolve.ts";
import { CREDENTIAL_VAULT_TYPE, SHARED_DEFAULT_ENV, VIDEO_ENGINE_CREDENTIAL_CATEGORIES, credentialStateOf, type VideoEngineCredentialCategory } from "./contract.ts";
import { openTestBackends, vaultRowId, withEnv } from "./test-databases.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { storeVaultCredential } from "../vault/service.ts";
import {
  getWorkspaceProviderSettings,
  removeWorkspaceProviderConfig,
  saveWorkspaceProviderConfig,
  testWorkspaceProviderConnection,
} from "../settings/provider-config.ts";

// Used only by this test process: the vault encrypts saved keys with this master key.
process.env.TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-video-engine-keys";

const backends = await openTestBackends();
after(async () => {
  for (const backend of backends) await backend.close();
});

// Every key here is a stub value. No test in this file calls a live provider.
const RULES: Record<VideoEngineCredentialCategory, { keyVariable: string; optIn: string; deployment: string; workspace: string }> = {
  openrouter: { keyVariable: "OPENROUTER_API_KEY", optIn: "OPENROUTER_SHARED_DEFAULT", deployment: "deployment-openrouter-key-1001", workspace: "workspace-openrouter-key-2001" },
  heygen: { keyVariable: "HEYGEN_API_KEY", optIn: "HEYGEN_SHARED_DEFAULT", deployment: "deployment-heygen-key-1002", workspace: "workspace-heygen-key-2002" },
  anthropic: { keyVariable: "ANTHROPIC_API_KEY", optIn: "ANTHROPIC_SHARED_DEFAULT", deployment: "deployment-anthropic-key-1003", workspace: "workspace-anthropic-key-2003" },
  deepgram: { keyVariable: "DEEPGRAM_API_KEY", optIn: "DEEPGRAM_SHARED_DEFAULT", deployment: "deployment-deepgram-key-1004", workspace: "workspace-deepgram-key-2004" },
};
/** Every other provider's deployment key, set at once, so a borrowed key would show. */
const OTHER_KEYS = {
  OPENAI_API_KEY: "other-openai-key-9001",
  MERIDIAN_GEMINI_API_KEY: "other-gemini-key-9002",
  HYPIT_API_TOKEN: "other-hypit-key-9003",
  TYPESAFE_JEV_API_KEY: "other-typesafe-key-9004",
};
const ALL_DEPLOYMENT_KEYS = Object.fromEntries(Object.values(RULES).map((rule) => [rule.keyVariable, rule.deployment]));

test("each video engine category has its own vault entry and its own shared-default rule", () => {
  assert.deepEqual([...VIDEO_ENGINE_CREDENTIAL_CATEGORIES], ["openrouter", "heygen", "anthropic", "deepgram"]);
  for (const category of VIDEO_ENGINE_CREDENTIAL_CATEGORIES) {
    assert.equal(CREDENTIAL_VAULT_TYPE[category], `provider_config:${category}`);
    assert.deepEqual(SHARED_DEFAULT_ENV[category], { variable: RULES[category].optIn, accepts: "deployment" });
  }
});

for (const { name, sql } of backends) {
  for (const category of VIDEO_ENGINE_CREDENTIAL_CATEGORIES) {
    const rule = RULES[category];

    test(`[${name}] ${category}: a usable workspace key is used first, even with the opt-in and a deployment key`, async () => {
      const tenant = await studioTenant(sql, `${category}-ws-${name}`);
      await storeVaultCredential(sql, tenant.organizationId, CREDENTIAL_VAULT_TYPE[category], { accessToken: "", apiKey: rule.workspace });
      await withEnv({ [rule.optIn]: "deployment", [rule.keyVariable]: rule.deployment }, async () => {
        const resolution = await resolveCredential(sql, tenant.organizationId, category);
        assert.equal(resolution.status, "ready");
        assert.equal(resolution.status === "ready" && resolution.source, "workspace");
        assert.equal(resolution.status === "ready" && resolution.secret, rule.workspace);
        assert.equal(resolution.status === "ready" && resolution.fingerprint, `...${rule.workspace.slice(-4)}`);
      });
    });

    test(`[${name}] ${category}: without ${rule.optIn}=deployment the deployment key is never used`, async () => {
      const tenant = await studioTenant(sql, `${category}-noopt-${name}`);
      for (const value of [undefined, "true", "1", "gemini"]) {
        await withEnv({ [rule.optIn]: value, [rule.keyVariable]: rule.deployment }, async () => {
          const resolution = await resolveCredential(sql, tenant.organizationId, category);
          assert.equal(resolution.status, "not_configured", `opt-in value ${String(value)}`);
          assert.match(resolution.status === "not_configured" ? resolution.reason : "", new RegExp(`${rule.optIn}=deployment`));
          assert.equal(JSON.stringify(resolution).includes(rule.deployment), false);
          assert.equal(sharedDefaultOptedIn(category), false);
        });
      }
    });

    test(`[${name}] ${category}: with the opt-in and no workspace entry, the deployment's ${rule.keyVariable} is the shared default`, async () => {
      const tenant = await studioTenant(sql, `${category}-opt-${name}`);
      await withEnv({ [rule.optIn]: "Deployment ", ...ALL_DEPLOYMENT_KEYS }, async () => {
        const resolution = await resolveCredential(sql, tenant.organizationId, category);
        assert.equal(resolution.status === "ready" && resolution.source, "deployment_shared_default");
        assert.equal(resolution.status === "ready" && resolution.secret, rule.deployment, "its own key, never another category's");
      });
    });

    test(`[${name}] ${category}: opted in with no ${rule.keyVariable} set, it does not borrow another provider's key`, async () => {
      const tenant = await studioTenant(sql, `${category}-noborrow-${name}`);
      const others = Object.fromEntries(Object.values(RULES).filter((other) => other !== rule).map((other) => [other.keyVariable, other.deployment]));
      await withEnv({ [rule.optIn]: "deployment", ...OTHER_KEYS, ...others }, async () => {
        const resolution = await resolveCredential(sql, tenant.organizationId, category);
        assert.equal(resolution.status, "not_configured");
        assert.match(resolution.status === "not_configured" ? resolution.reason : "", /no .* key set/);
        const text = JSON.stringify(resolution);
        for (const value of [...Object.values(OTHER_KEYS), ...Object.values(others)]) assert.equal(text.includes(value), false);
      });
    });

    test(`[${name}] ${category}: an expired, unreadable or empty saved key is unusable and never falls back`, async () => {
      const cases: Array<{ label: string; prepare: (organizationId: string) => Promise<void>; reason: RegExp }> = [
        {
          label: "expired",
          prepare: async (organizationId) => {
            await storeVaultCredential(sql, organizationId, CREDENTIAL_VAULT_TYPE[category], { accessToken: "", apiKey: rule.workspace }, { expiresAt: new Date(Date.now() - 60_000) });
          },
          reason: /expired/,
        },
        {
          label: "unreadable",
          prepare: async (organizationId) => {
            await storeVaultCredential(sql, organizationId, CREDENTIAL_VAULT_TYPE[category], { accessToken: "", apiKey: rule.workspace });
            const rowId = await vaultRowId(sql, organizationId, CREDENTIAL_VAULT_TYPE[category]);
            await sql.query("update credential_vault set ciphertext = $1 where id = $2", ["AAAA", rowId]);
          },
          reason: /could not be read/,
        },
        {
          label: "empty",
          prepare: async (organizationId) => {
            await storeVaultCredential(sql, organizationId, CREDENTIAL_VAULT_TYPE[category], { accessToken: "", apiKey: "  " });
          },
          reason: /holds no key/,
        },
      ];
      for (const testCase of cases) {
        const tenant = await studioTenant(sql, `${category}-${testCase.label}-${name}`);
        await testCase.prepare(tenant.organizationId);
        await withEnv({ [rule.optIn]: "deployment", [rule.keyVariable]: rule.deployment }, async () => {
          const resolution = await resolveCredential(sql, tenant.organizationId, category);
          assert.equal(resolution.status, "unusable", testCase.label);
          assert.match(resolution.status === "unusable" ? resolution.reason : "", testCase.reason, testCase.label);
          const state = credentialStateOf(resolution);
          assert.equal(state.fingerprint, null);
          assert.equal(JSON.stringify(resolution).includes(rule.deployment), false, `${testCase.label}: no deployment key`);
          assert.equal(JSON.stringify(resolution).includes(rule.workspace), false, `${testCase.label}: no saved key in the reason`);
        });
      }
    });

    test(`[${name}] ${category}: another workspace never receives this workspace's key, and no workspace in scope reads nothing`, async () => {
      const a = await studioTenant(sql, `${category}-iso-a-${name}`);
      const b = await studioTenant(sql, `${category}-iso-b-${name}`);
      await storeVaultCredential(sql, a.organizationId, CREDENTIAL_VAULT_TYPE[category], { accessToken: "", apiKey: rule.workspace });
      await withEnv({ [rule.keyVariable]: rule.deployment }, async () => {
        const other = await resolveCredential(sql, b.organizationId, category);
        assert.equal(other.status, "not_configured");
        assert.equal(JSON.stringify(other).includes(rule.workspace), false);
      });
      await withEnv({ [rule.optIn]: "deployment", [rule.keyVariable]: rule.deployment }, async () => {
        const none = await resolveCredential(sql, "  ", category);
        assert.equal(none.status, "not_configured");
        assert.match(none.status === "not_configured" ? none.reason : "", /No workspace is in scope/);
      });
    });

    test(`[${name}] ${category}: settings list it with a masked fingerprint, save and remove it, and Test Connection never passes`, async () => {
      const tenant = await studioTenant(sql, `${category}-settings-${name}`);
      await withEnv({}, async () => {
        const before = await getWorkspaceProviderSettings(sql, tenant.organizationId);
        assert.equal(before[category].credentialState, "not_configured");
        const untested = await testWorkspaceProviderConnection(sql, { organizationId: tenant.organizationId, category });
        assert.equal(untested.status, "ERROR");

        await saveWorkspaceProviderConfig(sql, { organizationId: tenant.organizationId, actorId: tenant.userId, category, credentials: { apiKey: rule.workspace } });
        const saved = await getWorkspaceProviderSettings(sql, tenant.organizationId);
        assert.equal(saved[category].credentialState, "usable");
        assert.equal(saved[category].source, "workspace");
        assert.equal(saved[category].keyFingerprint, `...${rule.workspace.slice(-4)}`);
        assert.equal(JSON.stringify(saved).includes(rule.workspace), false, "the summary never carries the key");

        const tested = await testWorkspaceProviderConnection(sql, { organizationId: tenant.organizationId, category });
        assert.equal(tested.status, "NOT_TESTABLE", "a readable key is not reported as a pass");
        assert.match(tested.message, /not testable here/);
        assert.equal(tested.message.includes(rule.workspace), false);

        await removeWorkspaceProviderConfig(sql, { organizationId: tenant.organizationId, actorId: tenant.userId, category });
        const removed = await getWorkspaceProviderSettings(sql, tenant.organizationId);
        assert.equal(removed[category].credentialState, "not_configured");
      });
    });
  }

  test(`[${name}] the deployment-only OpenRouter chat key keeps working beside the openrouter category`, async () => {
    const tenant = await studioTenant(sql, `openrouter-chat-${name}`);
    await storeVaultCredential(sql, tenant.organizationId, CREDENTIAL_VAULT_TYPE.openrouter, { accessToken: "", apiKey: RULES.openrouter.workspace });
    await withEnv({ OPENROUTER_SHARED_DEFAULT: "deployment", OPENROUTER_API_KEY: RULES.openrouter.deployment }, async () => {
      const chat = resolveDeploymentOnlyKey("openrouter_chat", process.env);
      assert.equal(chat.status === "ready" && chat.secret, RULES.openrouter.deployment, "the chat path reads the deployment key only");
      const workspace = await resolveCredential(sql, tenant.organizationId, "openrouter");
      assert.equal(workspace.status === "ready" && workspace.secret, RULES.openrouter.workspace, "the workspace path reads its own key");
    });
    await withEnv({ OPENROUTER_API_KEY: RULES.openrouter.deployment }, async () => {
      assert.equal(resolveDeploymentOnlyKey("openrouter_chat", process.env).status, "not_configured");
    });
  });
}
