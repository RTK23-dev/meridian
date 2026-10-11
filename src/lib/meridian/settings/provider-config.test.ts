import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import {
  getWorkspaceProviderSettings,
  removeWorkspaceProviderConfig,
  saveWorkspaceProviderConfig,
  testWorkspaceProviderConnection,
} from "./provider-config.ts";
import { resolveCredential } from "../credentials/resolve.ts";
import { CREDENTIAL_VAULT_TYPE, credentialStateOf, type CredentialCategory, type CredentialState } from "../credentials/contract.ts";
import { openTestBackends, vaultRowId, withEnv } from "../credentials/test-databases.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { storeVaultCredential } from "../vault/service.ts";
import type { Sql } from "../learning/store.ts";

// Used only by this test process: the vault encrypts saved keys with this master key.
process.env.TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-provider-settings";

const backends = await openTestBackends();
after(async () => {
  for (const backend of backends) await backend.close();
});

const DEPLOYMENT_GEMINI = "deployment-gemini-key-9876";
const DEPLOYMENT_TYPESAFE = "deployment-typesafe-key-5432";
const WORKSPACE_GEMINI = "workspace-gemini-key-1234";
const WORKSPACE_JEV = "workspace-jev-key-4321";

// The settings summary holds these three categories. OpenAI and Hypit have no settings entry, so they are not listed here.
const CREDENTIAL_CATEGORIES: Array<Extract<CredentialCategory, "perception" | "jev" | "production">> = ["perception", "jev", "production"];

/** The summary's source name for a resolver state. The panel and the summary use the same mapping. */
function expectedSourceOf(state: CredentialState): string {
  if (state.state === "not_configured") return "not_configured";
  if (state.state === "unusable") return "workspace";
  return state.source === "workspace" ? "workspace" : "deployment";
}

/**
 * A database wrapper that fails the vault insert, so a save can be checked against a write that fails after the old entry
 * was removed. Transactions are passed through, so the failure happens inside the save's transaction.
 */
function failingVaultInsert(sql: Sql): Sql {
  const wrap = (inner: Sql): Sql => {
    const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join("?").includes("insert into credential_vault")) {
        return Promise.reject(new Error("simulated write failure"));
      }
      return inner(strings, ...values);
    };
    const wrapped: any = run;
    wrapped.query = inner.query.bind(inner);
    if (inner.begin) {
      wrapped.begin = (work: (tx: Sql) => Promise<unknown>) => inner.begin!((tx) => work(wrap(tx)));
    }
    return wrapped as Sql;
  };
  return wrap(sql);
}

for (const { name, sql } of backends) {
  test(`[${name}] the settings summary shows each credential category's resolver state, for every scenario`, async () => {
    const scenarios: Array<{ label: string; env: Record<string, string>; setup: (org: string, userId: string) => Promise<void> }> = [
      { label: "nothing saved, no shared defaults", env: {}, setup: async () => {} },
      {
        label: "every category saved",
        env: {},
        setup: async (org) => {
          for (const category of CREDENTIAL_CATEGORIES) {
            await storeVaultCredential(sql, org, CREDENTIAL_VAULT_TYPE[category], { accessToken: "", apiKey: `${category}-workspace-key-7777` });
          }
        },
      },
      {
        label: "shared defaults opted in, nothing saved",
        env: { PERCEPTION_SHARED_DEFAULT: "gemini", MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_GEMINI, JEV_SHARED_DEFAULT: "deployment", TYPESAFE_JEV_API_KEY: DEPLOYMENT_TYPESAFE, PRODUCTION_SHARED_DEFAULT: "deployment" },
        setup: async () => {},
      },
      {
        label: "production saved but expired, shared default opted in",
        env: { PRODUCTION_SHARED_DEFAULT: "deployment", MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_GEMINI },
        setup: async (org) => {
          await storeVaultCredential(sql, org, CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: "expired-production-key-1111" }, { expiresAt: new Date(Date.now() - 60_000) });
        },
      },
    ];

    for (const scenario of scenarios) {
      const tenant = await studioTenant(sql, `panel-${scenario.label.replace(/\W+/g, "-")}`);
      await withEnv(scenario.env, async () => {
        await scenario.setup(tenant.organizationId, tenant.userId);
        const summary = await getWorkspaceProviderSettings(sql, tenant.organizationId);
        for (const category of CREDENTIAL_CATEGORIES) {
          const resolverState = credentialStateOf(await resolveCredential(sql, tenant.organizationId, category));
          const shown = summary[category];
          assert.equal(shown.credentialState, resolverState.state, `${scenario.label}: ${category} state`);
          assert.equal(shown.configured, resolverState.state === "usable", `${scenario.label}: ${category} configured`);
          assert.equal(shown.source, expectedSourceOf(resolverState), `${scenario.label}: ${category} source`);
          assert.equal(shown.keyFingerprint, resolverState.state === "usable" ? resolverState.fingerprint || undefined : undefined, `${scenario.label}: ${category} fingerprint`);
        }
      });
    }
  });

  test(`[${name}] JEV: the summary shows the workspace's saved key, and a deployment key only when JEV_SHARED_DEFAULT=deployment`, async () => {
    const tenant = await studioTenant(sql, "jev-summary");
    await storeVaultCredential(sql, tenant.organizationId, CREDENTIAL_VAULT_TYPE.jev, { accessToken: "", apiKey: WORKSPACE_JEV, customFields: { mode: "auto" } });

    await withEnv({ TYPESAFE_JEV_API_KEY: DEPLOYMENT_TYPESAFE }, async () => {
      const jev = (await getWorkspaceProviderSettings(sql, tenant.organizationId)).jev;
      assert.equal(jev.credentialState, "usable");
      assert.equal(jev.source, "workspace");
      assert.equal(jev.keyFingerprint, "...4321");
      assert.equal(JSON.stringify(jev).includes(DEPLOYMENT_TYPESAFE), false, "the deployment key is not shown");
    });

    const other = await studioTenant(sql, "jev-summary-other");
    await withEnv({ TYPESAFE_JEV_API_KEY: DEPLOYMENT_TYPESAFE }, async () => {
      const jev = (await getWorkspaceProviderSettings(sql, other.organizationId)).jev;
      assert.equal(jev.credentialState, "not_configured", "a deployment key alone is not shown as configured for JEV");
      assert.equal(jev.source, "not_configured");
      assert.equal(jev.configured, false);
    });

    await withEnv({ JEV_SHARED_DEFAULT: "deployment", TYPESAFE_JEV_API_KEY: DEPLOYMENT_TYPESAFE }, async () => {
      const jev = (await getWorkspaceProviderSettings(sql, other.organizationId)).jev;
      assert.equal(jev.credentialState, "usable");
      assert.equal(jev.source, "deployment", "the deployment shared default is named as the source");
      assert.equal(jev.keyFingerprint, "...5432");
      assert.equal(JSON.stringify(jev).includes(DEPLOYMENT_TYPESAFE), false);
    });
  });

  test(`[${name}] production: a saved workspace key is the one shown, and the deployment key is not shown without the flag`, async () => {
    const tenant = await studioTenant(sql, "production-summary");
    await storeVaultCredential(sql, tenant.organizationId, CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: WORKSPACE_GEMINI });

    await withEnv({ MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_GEMINI }, async () => {
      const production = (await getWorkspaceProviderSettings(sql, tenant.organizationId)).production;
      assert.equal(production.credentialState, "usable");
      assert.equal(production.source, "workspace", "production reads the workspace's saved key");
      assert.equal(production.keyFingerprint, "...1234");
      assert.equal(JSON.stringify(production).includes(WORKSPACE_GEMINI), false);
      assert.equal(JSON.stringify(production).includes(DEPLOYMENT_GEMINI), false);
    });

    const bare = await studioTenant(sql, "production-summary-bare");
    await withEnv({ MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_GEMINI }, async () => {
      const production = (await getWorkspaceProviderSettings(sql, bare.organizationId)).production;
      assert.equal(production.credentialState, "not_configured", "the environment key alone is not used for production");
      assert.equal(production.configured, false);
      assert.match(production.credentialReason ?? "", /PRODUCTION_SHARED_DEFAULT=deployment/);
    });
  });

  test(`[${name}] saving production settings without a new key keeps the stored key`, async () => {
    const tenant = await studioTenant(sql, "keep-key");
    await withEnv({}, async () => {
      await saveWorkspaceProviderConfig(sql, {
        organizationId: tenant.organizationId,
        actorId: tenant.userId,
        category: "production",
        credentials: { apiKey: WORKSPACE_GEMINI },
        settings: { costPreference: "BALANCED" },
      });
      const before = await resolveCredential(sql, tenant.organizationId, "production");
      assert.equal(before.status === "ready" && before.secret, WORKSPACE_GEMINI);

      // The regression: a settings-only save used to write an empty key over the stored one.
      await saveWorkspaceProviderConfig(sql, {
        organizationId: tenant.organizationId,
        actorId: tenant.userId,
        category: "production",
        settings: { costPreference: "QUALITY_FIRST" },
      });
      const after = await resolveCredential(sql, tenant.organizationId, "production");
      assert.equal(after.status === "ready" && after.secret, WORKSPACE_GEMINI, "the stored key is kept");

      const production = (await getWorkspaceProviderSettings(sql, tenant.organizationId)).production;
      assert.equal(production.credentialState, "usable");
      assert.equal(production.settings.costPreference, "QUALITY_FIRST", "the new setting is saved");
    });
  });

  test(`[${name}] a save with no key and no stored key is refused for every credential category, and creates no entry`, async () => {
    const tenant = await studioTenant(sql, "refused-save");
    await withEnv({}, async () => {
      for (const category of CREDENTIAL_CATEGORIES) {
        await assert.rejects(
          saveWorkspaceProviderConfig(sql, { organizationId: tenant.organizationId, actorId: tenant.userId, category, settings: {} }),
          /Enter a/,
          `${category} is refused`,
        );
        assert.equal(await vaultRowId(sql, tenant.organizationId, CREDENTIAL_VAULT_TYPE[category]), null, `${category}: no empty entry is created`);
      }
    });
  });

  test(`[${name}] a failed write during a save leaves the previous key in place: the save is one transaction`, async () => {
    const tenant = await studioTenant(sql, "atomic-save");
    await withEnv({}, async () => {
      await storeVaultCredential(sql, tenant.organizationId, CREDENTIAL_VAULT_TYPE.jev, { accessToken: "", apiKey: WORKSPACE_JEV });
      await assert.rejects(
        saveWorkspaceProviderConfig(failingVaultInsert(sql), {
          organizationId: tenant.organizationId,
          actorId: tenant.userId,
          category: "jev",
          credentials: { apiKey: "replacement-jev-key-9999" },
          settings: { mode: "openrouter" },
        }),
        /simulated write failure/,
      );
      const still = await resolveCredential(sql, tenant.organizationId, "jev");
      assert.equal(still.status === "ready" && still.secret, WORKSPACE_JEV, "the previous key survives the failed save");
      const audit = await sql<{ n: number }>`select count(*)::int as n from audit_log where organization_id = ${tenant.organizationId} and object_id = ${CREDENTIAL_VAULT_TYPE.jev}`;
      assert.equal(Number(audit[0]?.n ?? 0), 0, "no audit record is written for a save that did not happen");
    });
  });

  test(`[${name}] removing a key deletes it and writes its audit record in one transaction`, async () => {
    const tenant = await studioTenant(sql, "remove-key");
    await withEnv({}, async () => {
      await storeVaultCredential(sql, tenant.organizationId, CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: WORKSPACE_GEMINI });
      await removeWorkspaceProviderConfig(sql, { organizationId: tenant.organizationId, actorId: tenant.userId, category: "production" });
      assert.equal(await vaultRowId(sql, tenant.organizationId, CREDENTIAL_VAULT_TYPE.production), null);
      const audit = await sql<{ action: string }>`select action from audit_log where organization_id = ${tenant.organizationId} and object_id = ${CREDENTIAL_VAULT_TYPE.production}`;
      assert.ok(audit.some((row) => row.action === "provider_config.remove"));
    });
  });

  test(`[${name}] the audit record and the stored entry never hold the raw key`, async () => {
    const tenant = await studioTenant(sql, "audit-secret");
    await withEnv({}, async () => {
      await saveWorkspaceProviderConfig(sql, {
        organizationId: tenant.organizationId,
        actorId: tenant.userId,
        category: "jev",
        credentials: { apiKey: "sk-super-secret-key-12345" },
        settings: { mode: "typesafe_direct" },
      });
      const audit = await sql<{ metadata: unknown }>`select metadata from audit_log where organization_id = ${tenant.organizationId} and object_id = ${CREDENTIAL_VAULT_TYPE.jev}`;
      assert.ok(audit.length > 0, "the save is audited");
      assert.equal(JSON.stringify(audit).includes("sk-super-secret-key-12345"), false);
      const rows = await sql<{ ciphertext: string }>`select ciphertext from credential_vault where organization_id = ${tenant.organizationId}`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].ciphertext.includes("sk-super-secret-key-12345"), false, "the stored entry is encrypted");
    });
  });

  test(`[${name}] Test Connection reports READY only for a usable credential, and says the live provider was not called`, async () => {
    const usable = await studioTenant(sql, "test-usable");
    await storeVaultCredential(sql, usable.organizationId, CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: WORKSPACE_GEMINI });
    const expired = await studioTenant(sql, "test-expired");
    await storeVaultCredential(sql, expired.organizationId, CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: "expired-test-key-2222" }, { expiresAt: new Date(Date.now() - 60_000) });
    const none = await studioTenant(sql, "test-none");

    await withEnv({ MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_GEMINI, PRODUCTION_SHARED_DEFAULT: "deployment" }, async () => {
      const ok = await testWorkspaceProviderConnection(sql, { organizationId: usable.organizationId, category: "production" });
      assert.equal(ok.status, "READY");
      assert.match(ok.message, /not called/);
      assert.equal(ok.message.includes(WORKSPACE_GEMINI), false);

      const bad = await testWorkspaceProviderConnection(sql, { organizationId: expired.organizationId, category: "production" });
      assert.equal(bad.status, "ERROR", "an expired saved key is never READY, even with the shared default on");
      assert.match(bad.message, /expired/);
      assert.equal(bad.message.includes(DEPLOYMENT_GEMINI), false);
    });

    await withEnv({ MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_GEMINI }, async () => {
      const unshared = await testWorkspaceProviderConnection(sql, { organizationId: none.organizationId, category: "production" });
      assert.equal(unshared.status, "ERROR", "an unshared deployment key is not READY");
    });

    await withEnv({ JEV_SHARED_DEFAULT: "deployment", TYPESAFE_JEV_API_KEY: DEPLOYMENT_TYPESAFE }, async () => {
      const jev = await testWorkspaceProviderConnection(sql, { organizationId: none.organizationId, category: "jev" });
      assert.equal(jev.status, "READY");
      assert.match(jev.message, /not called/);
      assert.match(jev.message, /OpenRouter is deployment-only and was not checked/);
      assert.equal(jev.message.includes(DEPLOYMENT_TYPESAFE), false);
    });
  });

  test(`[${name}] perception: PERCEPTION_PROVIDER=none turns it off in the summary and in Test Connection, even with a saved key`, async () => {
    const tenant = await studioTenant(sql, "perception-off");
    await withEnv({ PERCEPTION_PROVIDER: "none", PERCEPTION_SHARED_DEFAULT: "gemini", MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_GEMINI }, async () => {
      await saveWorkspaceProviderConfig(sql, {
        organizationId: tenant.organizationId,
        actorId: tenant.userId,
        category: "perception",
        credentials: { apiKey: WORKSPACE_GEMINI },
      });
      const perception = (await getWorkspaceProviderSettings(sql, tenant.organizationId)).perception;
      assert.equal(perception.configured, false, "the panel must not show perception as configured while it is turned off");
      assert.equal(perception.credentialState, "not_configured");
      assert.equal(perception.source, "not_configured");
      assert.equal(perception.keyFingerprint, undefined);
      assert.match(perception.credentialReason ?? "", /PERCEPTION_PROVIDER=none/);

      const connection = await testWorkspaceProviderConnection(sql, { organizationId: tenant.organizationId, category: "perception" });
      assert.equal(connection.status, "ERROR");
      assert.match(connection.message, /PERCEPTION_PROVIDER=none/);
    });
  });

  test(`[${name}] a perception entry with no key is unusable and never falls back to the deployment key`, async () => {
    const tenant = await studioTenant(sql, "perception-empty");
    await withEnv({ PERCEPTION_SHARED_DEFAULT: "gemini", MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_GEMINI }, async () => {
      // The entry decrypts, but holds no key. The save path refuses this, so it can only come from elsewhere.
      await storeVaultCredential(sql, tenant.organizationId, CREDENTIAL_VAULT_TYPE.perception, { accessToken: "", apiKey: "", customFields: {} });
      const perception = (await getWorkspaceProviderSettings(sql, tenant.organizationId)).perception;
      assert.equal(perception.credentialState, "unusable");
      assert.equal(perception.configured, false);
      assert.match(perception.credentialReason ?? "", /holds no key/);
      assert.equal(JSON.stringify(perception).includes(DEPLOYMENT_GEMINI), false, "no fallback to the deployment key");
    });
  });

  test(`[${name}] redaction: the summary never carries a raw key, and a short key shows no fingerprint`, async () => {
    const tenant = await studioTenant(sql, "redaction");
    await storeVaultCredential(sql, tenant.organizationId, CREDENTIAL_VAULT_TYPE.jev, { accessToken: "", apiKey: "short1" });
    await storeVaultCredential(sql, tenant.organizationId, CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: WORKSPACE_GEMINI });
    await withEnv({ TYPESAFE_JEV_API_KEY: DEPLOYMENT_TYPESAFE, MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_GEMINI, PERCEPTION_SHARED_DEFAULT: "gemini" }, async () => {
      const summary = await getWorkspaceProviderSettings(sql, tenant.organizationId);
      const json = JSON.stringify(summary);
      for (const secret of ["short1", WORKSPACE_GEMINI, DEPLOYMENT_GEMINI, DEPLOYMENT_TYPESAFE]) {
        assert.equal(json.includes(secret), false, `the summary must not carry ${secret}`);
      }
      assert.equal(summary.jev.keyFingerprint, undefined, "a key shorter than eight characters shows no fingerprint");
      assert.equal(summary.production.keyFingerprint, "...1234");

      for (const category of CREDENTIAL_CATEGORIES) {
        const state = credentialStateOf(await resolveCredential(sql, tenant.organizationId, category));
        assert.equal(JSON.stringify(state).includes(WORKSPACE_GEMINI), false);
        assert.equal(JSON.stringify(state).includes(DEPLOYMENT_GEMINI), false);
      }
    });
  });
}

test("the settings summary and the save path never read a provider key from the environment directly", () => {
  const source = readFileSync(new URL("./provider-config.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /process\.env\.(MERIDIAN_GEMINI_API_KEY|GOOGLE_AI_STUDIO_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|TYPESAFE_JEV_API_KEY)/);
});

test("SSRF: a configurable endpoint on a private address is refused before anything is written", async () => {
  const noDatabase = {} as unknown as Sql;
  await assert.rejects(
    saveWorkspaceProviderConfig(noDatabase, {
      organizationId: "org-1",
      actorId: "user-1",
      category: "production",
      settings: { endpointUrl: "http://169.254.169.254/latest/meta-data/" },
    }),
    /Invalid URL for endpointUrl/,
  );
});
