import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  getWorkspaceProviderSettings,
  isProviderCategory,
  KEYED_PROVIDER_CATEGORIES,
  removeWorkspaceProviderConfig,
  saveWorkspaceProviderConfig,
  testWorkspaceProviderConnection,
  type ProviderCategory,
} from "./provider-config.ts";
import { resolveCredential } from "../credentials/resolve.ts";
import { CREDENTIAL_VAULT_TYPE, SHARED_DEFAULT_ENV, SOURCE_CREDENTIAL_CATEGORIES, type CredentialCategory } from "../credentials/contract.ts";
import { openTestBackends, vaultRowId, withEnv } from "../credentials/test-databases.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { retrieveVaultCredential } from "../vault/service.ts";

// Used only by this test process: the vault encrypts saved keys with this master key.
process.env.TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-provider-save-keys";

const backends = await openTestBackends();
after(async () => {
  for (const backend of backends) await backend.close();
});

const SOURCE_CATEGORIES = SOURCE_CREDENTIAL_CATEGORIES as readonly CredentialCategory[];
const keyFor = (category: string) => `saved-${category}-key-${category.length}7777`;
const keyTail = (key: string) => key.slice(-4);

/** The categories that are not settings-only: every one saves a key. */
test("the keyed categories are exactly the resolver's categories, and only they are accepted as keyed", () => {
  assert.deepEqual([...KEYED_PROVIDER_CATEGORIES].sort(), Object.keys(CREDENTIAL_VAULT_TYPE).sort());
  for (const category of KEYED_PROVIDER_CATEGORIES) assert.equal(isProviderCategory(category), true, category);
  for (const category of ["sources", "storage", "cyclone"]) assert.equal(isProviderCategory(category), true, category);
  for (const value of ["", "veo", "provider_config:jev", "openrouter", 42, null]) {
    assert.equal(isProviderCategory(value), false, String(value));
  }
});

for (const { name, sql } of backends) {
  test(`[${name}] every keyed category saves its key into its own entry, and the resolver reads that entry`, async () => {
    const tenant = await studioTenant(sql, `keyed-each-${name}`);
    await withEnv({}, async () => {
      for (const category of KEYED_PROVIDER_CATEGORIES) {
        await saveWorkspaceProviderConfig(sql, {
          organizationId: tenant.organizationId,
          actorId: tenant.userId,
          category: category as ProviderCategory,
          credentials: { apiKey: keyFor(category) },
        });
        assert.notEqual(await vaultRowId(sql, tenant.organizationId, CREDENTIAL_VAULT_TYPE[category]), null, `${category}: entry exists`);
        const resolution = await resolveCredential(sql, tenant.organizationId, category);
        assert.equal(resolution.status, "ready", `${category}: resolver is ready`);
        if (resolution.status === "ready") {
          assert.equal(resolution.source, "workspace", `${category}: the workspace's own key`);
          assert.equal(resolution.secret, keyFor(category), `${category}: the saved key is the one read`);
        }
      }
      // A source connector never writes the generic provider_config:<category> entry that settings use.
      for (const category of SOURCE_CATEGORIES) {
        assert.equal(await vaultRowId(sql, tenant.organizationId, `provider_config:${category}`), null, `${category}: no settings entry`);
      }
    });
  });

  test(`[${name}] a save with no key and no stored key is refused for every keyed category, and creates no entry`, async () => {
    const tenant = await studioTenant(sql, `keyed-refused-${name}`);
    await withEnv({}, async () => {
      for (const category of KEYED_PROVIDER_CATEGORIES) {
        await assert.rejects(
          saveWorkspaceProviderConfig(sql, { organizationId: tenant.organizationId, actorId: tenant.userId, category: category as ProviderCategory, settings: {} }),
          /Enter an API key for/,
          `${category} is refused`,
        );
        assert.equal(await vaultRowId(sql, tenant.organizationId, CREDENTIAL_VAULT_TYPE[category]), null, `${category}: no empty entry`);
      }
    });
  });

  test(`[${name}] a save without a key keeps the stored key for OpenAI, Hypit and a source connector`, async () => {
    const tenant = await studioTenant(sql, `keyed-keep-${name}`);
    await withEnv({}, async () => {
      for (const category of ["openai", "hypit", "meta_ad_library", "youtube"] as const) {
        await saveWorkspaceProviderConfig(sql, { organizationId: tenant.organizationId, actorId: tenant.userId, category, credentials: { apiKey: keyFor(category) } });
        await saveWorkspaceProviderConfig(sql, { organizationId: tenant.organizationId, actorId: tenant.userId, category, credentials: { apiKey: "   " } });
        const resolution = await resolveCredential(sql, tenant.organizationId, category);
        assert.equal(resolution.status === "ready" && resolution.secret, keyFor(category), `${category}: the stored key is kept`);
      }
    });
  });

  test(`[${name}] replacing a production key keeps the stored cost preference`, async () => {
    const tenant = await studioTenant(sql, `keyed-keep-settings-${name}`);
    await withEnv({}, async () => {
      await saveWorkspaceProviderConfig(sql, {
        organizationId: tenant.organizationId,
        actorId: tenant.userId,
        category: "production",
        credentials: { apiKey: "production-first-key-1111" },
        settings: { costPreference: "ZERO_SPEND" },
      });
      await saveWorkspaceProviderConfig(sql, {
        organizationId: tenant.organizationId,
        actorId: tenant.userId,
        category: "production",
        credentials: { apiKey: "production-second-key-2222" },
      });
      const summary = (await getWorkspaceProviderSettings(sql, tenant.organizationId)).production;
      assert.equal(summary.settings.costPreference, "ZERO_SPEND", "the stored cost preference survives a key replacement");
      assert.equal(summary.keyFingerprint, `...${keyTail("production-second-key-2222")}`, "the new key is the one in use");
    });
  });

  test(`[${name}] the legacy sources form: a Meta token alone writes no sources setting, and keeps maxPages`, async () => {
    const tenant = await studioTenant(sql, `keyed-legacy-meta-${name}`);
    await withEnv({}, async () => {
      await saveWorkspaceProviderConfig(sql, {
        organizationId: tenant.organizationId,
        actorId: tenant.userId,
        category: "sources",
        settings: { maxPages: 20 },
      });
      const sourcesRow = await vaultRowId(sql, tenant.organizationId, "provider_config:sources");
      await saveWorkspaceProviderConfig(sql, {
        organizationId: tenant.organizationId,
        actorId: tenant.userId,
        category: "sources",
        settings: { metaAdLibraryToken: "legacy-meta-token-3333" },
      });
      assert.equal(await vaultRowId(sql, tenant.organizationId, "provider_config:sources"), sourcesRow, "the sources entry is not rewritten");
      const summary = (await getWorkspaceProviderSettings(sql, tenant.organizationId)).sources;
      assert.equal(summary.settings.maxPagesPerRun, 20, "maxPages is kept");
      assert.equal(summary.settings.metaAdLibraryConfigured, true, "the Meta token is saved in its own entry");
    });
  });

  test(`[${name}] the legacy sources form stores the Meta token in its own entry, never in the sources settings`, async () => {
    const tenant = await studioTenant(sql, `keyed-legacy-split-${name}`);
    await withEnv({}, async () => {
      await saveWorkspaceProviderConfig(sql, {
        organizationId: tenant.organizationId,
        actorId: tenant.userId,
        category: "sources",
        settings: { maxPages: 15, metaAdLibraryToken: "legacy-split-token-4444" },
      });
      const sourcesId = await vaultRowId(sql, tenant.organizationId, "provider_config:sources");
      assert.ok(sourcesId, "the sources settings are saved");
      const sourcesPayload = await retrieveVaultCredential(sql, tenant.organizationId, sourcesId);
      assert.equal(sourcesPayload?.customFields?.maxPages, 15);
      assert.equal("metaAdLibraryToken" in (sourcesPayload?.customFields ?? {}), false, "the token is not in the sources settings");
      const metaId = await vaultRowId(sql, tenant.organizationId, CREDENTIAL_VAULT_TYPE.meta_ad_library);
      assert.ok(metaId, "the Meta token has its own entry");
      assert.equal((await retrieveVaultCredential(sql, tenant.organizationId, metaId))?.apiKey, "legacy-split-token-4444");
    });
  });

  test(`[${name}] removing a source key deletes only its own entry`, async () => {
    const tenant = await studioTenant(sql, `keyed-remove-scoped-${name}`);
    await withEnv({}, async () => {
      await saveWorkspaceProviderConfig(sql, { organizationId: tenant.organizationId, actorId: tenant.userId, category: "meta_ad_library", credentials: { apiKey: "meta-remove-key-5555" } });
      await saveWorkspaceProviderConfig(sql, { organizationId: tenant.organizationId, actorId: tenant.userId, category: "youtube", credentials: { apiKey: "youtube-keep-key-6666" } });
      await removeWorkspaceProviderConfig(sql, { organizationId: tenant.organizationId, actorId: tenant.userId, category: "meta_ad_library" });
      assert.equal(await vaultRowId(sql, tenant.organizationId, CREDENTIAL_VAULT_TYPE.meta_ad_library), null);
      assert.notEqual(await vaultRowId(sql, tenant.organizationId, CREDENTIAL_VAULT_TYPE.youtube), null, "the other connector keeps its key");
      const audit = await sql<{ object_id: string; object_type: string }>`
        select object_id, object_type from audit_log
        where organization_id = ${tenant.organizationId} and action = 'provider_config.remove'
      `;
      assert.deepEqual(audit.map((row) => [row.object_type, row.object_id]), [["meta_ad_library", CREDENTIAL_VAULT_TYPE.meta_ad_library]]);
    });
  });

  test(`[${name}] an unknown category is refused by the save and the removal, and writes nothing`, async () => {
    const tenant = await studioTenant(sql, `keyed-unknown-${name}`);
    await assert.rejects(
      saveWorkspaceProviderConfig(sql, { organizationId: tenant.organizationId, actorId: tenant.userId, category: "veo" as ProviderCategory, credentials: { apiKey: "unknown-key-7777" } }),
      /Unknown provider category: veo/,
    );
    await assert.rejects(
      removeWorkspaceProviderConfig(sql, { organizationId: tenant.organizationId, actorId: tenant.userId, category: "veo" as ProviderCategory }),
      /Unknown provider category: veo/,
    );
    const rows = await sql<{ n: number }>`select count(*)::int as n from credential_vault where organization_id = ${tenant.organizationId}`;
    assert.equal(rows[0]?.n, 0);
  });

  test(`[${name}] the audit record of a keyed save names its own category and never holds the key`, async () => {
    const tenant = await studioTenant(sql, `keyed-audit-${name}`);
    const key = "openai-audit-secret-8888";
    await withEnv({}, async () => {
      await saveWorkspaceProviderConfig(sql, { organizationId: tenant.organizationId, actorId: tenant.userId, category: "openai", credentials: { apiKey: key } });
    });
    const audit = await sql<{ object_type: string; object_id: string; metadata: unknown }>`
      select object_type, object_id, metadata from audit_log
      where organization_id = ${tenant.organizationId} and object_id = ${CREDENTIAL_VAULT_TYPE.openai}
    `;
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.object_type, "openai");
    assert.equal(JSON.stringify(audit[0]).includes(key), false, "the audit record never holds the key");
  });

  test(`[${name}] a key saved for one workspace is not visible to another, and the summary never carries a raw key`, async () => {
    const owner = await studioTenant(sql, `keyed-tenancy-a-${name}`);
    const other = await studioTenant(sql, `keyed-tenancy-b-${name}`);
    const key = "tenancy-owner-key-9999";
    await withEnv({}, async () => {
      await saveWorkspaceProviderConfig(sql, { organizationId: owner.organizationId, actorId: owner.userId, category: "hypit", credentials: { apiKey: key } });
      const ownerSummary = await getWorkspaceProviderSettings(sql, owner.organizationId);
      const otherSummary = await getWorkspaceProviderSettings(sql, other.organizationId);
      assert.equal(ownerSummary.hypit.credentialState, "usable");
      assert.equal(otherSummary.hypit.credentialState, "not_configured", "the other workspace has no Hypit key");
      assert.equal(JSON.stringify(ownerSummary).includes(key), false);
      assert.equal(JSON.stringify(otherSummary).includes(key), false);
    });
  });

  test(`[${name}] the summary holds every keyed category, with its state, source and fingerprint`, async () => {
    const tenant = await studioTenant(sql, `keyed-summary-${name}`);
    await withEnv({ HYPIT_BASE_URL: "http://127.0.0.1:9" }, async () => {
      await saveWorkspaceProviderConfig(sql, { organizationId: tenant.organizationId, actorId: tenant.userId, category: "meta_ad_library", credentials: { apiKey: "summary-meta-key-1010" } });
      const summary = await getWorkspaceProviderSettings(sql, tenant.organizationId);
      for (const category of KEYED_PROVIDER_CATEGORIES) {
        assert.ok(summary[category as ProviderCategory], `${category} is in the summary`);
      }
      assert.equal(summary.meta_ad_library.credentialState, "usable");
      assert.equal(summary.meta_ad_library.source, "workspace");
      assert.equal(summary.meta_ad_library.keyFingerprint, "...1010");
      assert.equal(summary.openai.credentialState, "not_configured");
      assert.equal(summary.hypit.settings.baseUrlConfigured, true);
    });
    await withEnv({ HYPIT_BASE_URL: undefined }, async () => {
      const summary = await getWorkspaceProviderSettings(sql, tenant.organizationId);
      assert.equal(summary.hypit.settings.baseUrlConfigured, false);
    });
  });

  test(`[${name}] a source connector's deployment key is used only when its shared default is opted in`, async () => {
    const tenant = await studioTenant(sql, `keyed-shared-${name}`);
    const rule = SHARED_DEFAULT_ENV.youtube;
    await withEnv({ YOUTUBE_API_KEY: "deployment-youtube-key-1212", [rule.variable]: undefined }, async () => {
      assert.equal((await getWorkspaceProviderSettings(sql, tenant.organizationId)).youtube.credentialState, "not_configured");
    });
    await withEnv({ YOUTUBE_API_KEY: "deployment-youtube-key-1212", [rule.variable]: rule.accepts }, async () => {
      const summary = (await getWorkspaceProviderSettings(sql, tenant.organizationId)).youtube;
      assert.equal(summary.credentialState, "usable");
      assert.equal(summary.source, "deployment");
      assert.equal(summary.keyFingerprint, "...1212");
    });
  });

  test(`[${name}] Test Connection for a keyed category is READY only with a usable key, and says the live provider was not called`, async () => {
    const tenant = await studioTenant(sql, `keyed-test-${name}`);
    await withEnv({}, async () => {
      const before = await testWorkspaceProviderConnection(sql, { organizationId: tenant.organizationId, category: "openai" });
      assert.notEqual(before.status, "READY");
      await saveWorkspaceProviderConfig(sql, { organizationId: tenant.organizationId, actorId: tenant.userId, category: "openai", credentials: { apiKey: "openai-test-key-1313" } });
      const after = await testWorkspaceProviderConnection(sql, { organizationId: tenant.organizationId, category: "openai" });
      assert.equal(after.status, "READY");
      assert.match(after.message, /not called/);
      assert.equal(after.message.includes("openai-test-key-1313"), false);
    });
  });

  test(`[${name}] every source connector can be saved from the same path and is listed by its own category`, async () => {
    const tenant = await studioTenant(sql, `keyed-sources-${name}`);
    await withEnv({}, async () => {
      for (const category of SOURCE_CATEGORIES) {
        await saveWorkspaceProviderConfig(sql, { organizationId: tenant.organizationId, actorId: tenant.userId, category: category as ProviderCategory, credentials: { apiKey: keyFor(category) } });
      }
      const summary = await getWorkspaceProviderSettings(sql, tenant.organizationId);
      for (const category of SOURCE_CATEGORIES) {
        assert.equal(summary[category as ProviderCategory].credentialState, "usable", `${category} is usable`);
      }
    });
  });
}
