import assert from "node:assert/strict";
import test from "node:test";
import {
  getWorkspaceProviderSettings,
  saveWorkspaceProviderConfig,
  testWorkspaceProviderConnection,
} from "./provider-config.ts";
import { storeVaultCredential } from "../vault/service.ts";

const DEPLOYMENT_KEY = "shared-deployment-key-9876";
const WORKSPACE_KEY = "workspace-gemini-key-1234";

/**
 * A vault that really encrypts: saved rows hold ciphertext, and reads decrypt it through the production vault service.
 * Only the SQL shapes the provider settings path uses are answered; everything else resolves to no rows.
 */
function fakeVaultSql() {
  const rows: Array<Record<string, any>> = [];
  const executed: Array<{ query: string; values: any[] }> = [];
  const sql: any = (strings: TemplateStringsArray, ...values: any[]) => {
    const query = strings.join("?");
    executed.push({ query, values });
    if (query.includes("insert into credential_vault")) {
      rows.push({
        id: values[0],
        organization_id: values[1],
        credential_type: values[2],
        ciphertext: values[3],
        iv: values[4],
        tag: values[5],
        key_version: values[6],
        expires_at: values[7] ?? null,
        updated_at: new Date().toISOString(),
      });
      return Promise.resolve([]);
    }
    if (query.includes("delete from credential_vault")) {
      const index = rows.findIndex((r) => r.id === values[0] && r.organization_id === values[1]);
      if (index >= 0) rows.splice(index, 1);
      return Promise.resolve([]);
    }
    if (query.includes("select id, expires_at from credential_vault")) {
      return Promise.resolve(
        rows.filter((r) => r.organization_id === values[0] && r.credential_type === values[1]).slice(0, 1)
          .map((r) => ({ id: r.id, expires_at: r.expires_at })),
      );
    }
    if (query.includes("select id from credential_vault")) {
      return Promise.resolve(
        rows.filter((r) => r.organization_id === values[0] && r.credential_type === values[1]).slice(0, 1)
          .map((r) => ({ id: r.id })),
      );
    }
    if (query.includes("select id, credential_type, updated_at from credential_vault")) {
      return Promise.resolve(
        rows.filter((r) => r.organization_id === values[0] && String(r.credential_type).startsWith("provider_config:"))
          .map((r) => ({ id: r.id, credential_type: r.credential_type, updated_at: r.updated_at })),
      );
    }
    if (query.includes("select id, organization_id, ciphertext")) {
      return Promise.resolve(rows.filter((r) => r.id === values[0] && r.organization_id === values[1]));
    }
    return Promise.resolve([]);
  };
  return { sql, rows, executed };
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const keys = ["TOKEN_ENCRYPTION_KEY", "PERCEPTION_SHARED_DEFAULT", "MERIDIAN_GEMINI_API_KEY", ...Object.keys(vars)];
  const original = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const next = {
    TOKEN_ENCRYPTION_KEY: "test-encryption-key-for-provider-settings",
    PERCEPTION_SHARED_DEFAULT: undefined,
    MERIDIAN_GEMINI_API_KEY: undefined,
    ...vars,
  };
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  }
}

test("ProviderConfigService: perception with no workspace key and no shared default is not configured", async () => {
  await withEnv({ MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_KEY }, async () => {
    const { sql } = fakeVaultSql();
    const perception = (await getWorkspaceProviderSettings(sql, "org-none")).perception;
    assert.equal(perception.configured, false);
    assert.equal(perception.credentialState, "not_configured");
    assert.equal(perception.source, "not_configured");
    assert.equal(perception.keyFingerprint, undefined);
    assert.match(perception.credentialReason ?? "", /does not share one/);
    assert.equal(JSON.stringify(perception).includes(DEPLOYMENT_KEY), false, "a deployment key that is not shared must not appear");
  });
});

test("ProviderConfigService: the deployment Gemini key is used for perception only as the intentional shared default", async () => {
  await withEnv({ PERCEPTION_SHARED_DEFAULT: "gemini", MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_KEY }, async () => {
    const { sql } = fakeVaultSql();
    const perception = (await getWorkspaceProviderSettings(sql, "org-shared")).perception;
    assert.equal(perception.configured, true);
    assert.equal(perception.credentialState, "usable");
    assert.equal(perception.source, "deployment");
    assert.equal(perception.keyFingerprint, "...9876");
    assert.equal(perception.credentialReason, undefined);
    assert.equal(JSON.stringify(perception).includes(DEPLOYMENT_KEY), false, "the raw deployment key must never appear");
  });
});

test("ProviderConfigService: a stored workspace perception key that becomes unusable is reported unusable and never falls back to the deployment key", async () => {
  await withEnv({ PERCEPTION_SHARED_DEFAULT: "gemini", MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_KEY }, async () => {
    const { sql, rows } = fakeVaultSql();
    await saveWorkspaceProviderConfig(sql, {
      organizationId: "org-regression",
      actorId: "admin-1",
      category: "perception",
      credentials: { apiKey: WORKSPACE_KEY },
    });

    // 1. Usable: the workspace's own key is used, and the deployment key is not reported.
    let summary = await getWorkspaceProviderSettings(sql, "org-regression");
    assert.equal(summary.perception.credentialState, "usable");
    assert.equal(summary.perception.source, "workspace");
    assert.equal(summary.perception.keyFingerprint, "...1234");
    const usableJson = JSON.stringify(summary);
    assert.equal(usableJson.includes(WORKSPACE_KEY), false, "the raw workspace key must never appear");
    assert.equal(usableJson.includes(DEPLOYMENT_KEY), false, "the deployment key must not appear while the workspace key is usable");

    // 2. Expired: the saved key is unusable. The shared default is set and available, but must not be used.
    rows[0].expires_at = "2020-01-01T00:00:00.000Z";
    summary = await getWorkspaceProviderSettings(sql, "org-regression");
    assert.equal(summary.perception.configured, false);
    assert.equal(summary.perception.credentialState, "unusable");
    assert.equal(summary.perception.source, "workspace", "the unusable entry is still the workspace's own entry, so Remove Key stays available");
    assert.equal(summary.perception.keyFingerprint, undefined);
    assert.match(summary.perception.credentialReason ?? "", /expired/);
    assert.equal(summary.perception.lastTestedStatus, "ERROR");
    const expiredJson = JSON.stringify(summary);
    assert.equal(expiredJson.includes(DEPLOYMENT_KEY), false, "no fallback to the deployment key");
    // Production legitimately fingerprints the deployment key for its own category, so check the perception entry alone.
    assert.equal(JSON.stringify(summary.perception).includes("...9876"), false, "no fingerprint of the deployment key in perception");

    // 3. Unreadable: the stored payload no longer decrypts. Still unusable, still no fallback.
    rows[0].expires_at = null;
    rows[0].ciphertext = "AAAA";
    summary = await getWorkspaceProviderSettings(sql, "org-regression");
    assert.equal(summary.perception.credentialState, "unusable");
    assert.equal(summary.perception.keyFingerprint, undefined);
    assert.match(summary.perception.credentialReason ?? "", /could not be read/);
    assert.equal(JSON.stringify(summary).includes(DEPLOYMENT_KEY), false, "no fallback to the deployment key");

    // The connection test reports the same thing, and does not claim READY.
    const connection = await testWorkspaceProviderConnection(sql, { organizationId: "org-regression", category: "perception" });
    assert.equal(connection.status, "ERROR");
    assert.match(connection.message, /could not be read/);
  });
});

test("ProviderConfigService: a workspace perception entry with no key is unusable, not configured", async () => {
  await withEnv({ PERCEPTION_SHARED_DEFAULT: "gemini", MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_KEY }, async () => {
    const { sql } = fakeVaultSql();
    // The entry decrypts, but holds no key. The save path refuses this, so it can only come from elsewhere.
    await storeVaultCredential(sql, "org-empty", "provider_config:perception", {
      accessToken: "",
      apiKey: "",
      refreshToken: "",
      customFields: {},
    });
    const perception = (await getWorkspaceProviderSettings(sql, "org-empty")).perception;
    assert.equal(perception.credentialState, "unusable");
    assert.equal(perception.configured, false);
    assert.match(perception.credentialReason ?? "", /holds no Gemini API key/);
    assert.equal(JSON.stringify(perception).includes(DEPLOYMENT_KEY), false, "no fallback to the deployment key");
  });
});

test("ProviderConfigService: Test Connection for perception reports READY only for a usable credential", async () => {
  await withEnv({ PERCEPTION_SHARED_DEFAULT: "gemini", MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_KEY }, async () => {
    const shared = await testWorkspaceProviderConnection(fakeVaultSql().sql, { organizationId: "org-x", category: "perception" });
    assert.equal(shared.status, "READY");
    assert.match(shared.message, /not called/, "the check must say it did not call Gemini");
    assert.equal(shared.message.includes(DEPLOYMENT_KEY), false, "the message must not carry the key");
  });

  await withEnv({ PERCEPTION_SHARED_DEFAULT: undefined, MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_KEY }, async () => {
    const none = await testWorkspaceProviderConnection(fakeVaultSql().sql, { organizationId: "org-y", category: "perception" });
    assert.equal(none.status, "ERROR", "an unshared deployment key is not a usable perception credential");
  });
});

test("ProviderConfigService: PERCEPTION_PROVIDER=none turns perception off in the settings summary and in Test Connection, even with a saved key", async () => {
  await withEnv({ PERCEPTION_PROVIDER: "none", PERCEPTION_SHARED_DEFAULT: "gemini", MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_KEY }, async () => {
    const { sql } = fakeVaultSql();
    await saveWorkspaceProviderConfig(sql, {
      organizationId: "org-off",
      actorId: "admin-1",
      category: "perception",
      credentials: { apiKey: WORKSPACE_KEY },
    });
    const perception = (await getWorkspaceProviderSettings(sql, "org-off")).perception;
    assert.equal(perception.configured, false, "the panel must not show perception as configured while it is turned off");
    assert.equal(perception.credentialState, "not_configured");
    assert.equal(perception.source, "not_configured");
    assert.equal(perception.keyFingerprint, undefined);
    assert.match(perception.credentialReason ?? "", /PERCEPTION_PROVIDER=none/);

    const connection = await testWorkspaceProviderConnection(sql, { organizationId: "org-off", category: "perception" });
    assert.equal(connection.status, "ERROR");
    assert.match(connection.message, /PERCEPTION_PROVIDER=none/);
  });
});

test("ProviderConfigService: saving perception without a key is refused and leaves the stored key alone", async () => {
  await withEnv({ PERCEPTION_SHARED_DEFAULT: undefined }, async () => {
    const { sql, rows, executed } = fakeVaultSql();
    await saveWorkspaceProviderConfig(sql, {
      organizationId: "org-keep",
      actorId: "admin-1",
      category: "perception",
      credentials: { apiKey: WORKSPACE_KEY },
    });
    const before = rows.map((r) => r.id);
    const writesBefore = executed.length;

    await assert.rejects(
      saveWorkspaceProviderConfig(sql, {
        organizationId: "org-keep",
        actorId: "admin-1",
        category: "perception",
        settings: {},
      }),
      /Enter a Gemini API key/,
    );

    assert.deepEqual(rows.map((r) => r.id), before, "the stored entry is untouched");
    const writes = executed.slice(writesBefore).filter((q) => /insert into|delete from/.test(q.query));
    assert.equal(writes.length, 0, "no delete or insert runs when the save is refused");
  });
});

test("ProviderConfigService: summarizes settings without leaking secrets", async () => {
  const originalKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-provider-settings";

  const vaultRows: Array<{ id: string; organization_id: string; credential_type: string; updated_at: string }> = [];

  const mockSql: any = (strings: TemplateStringsArray, ..._values: any[]) => {
    const query = strings.join("?");
    if (query.includes("select id, credential_type, updated_at from credential_vault")) {
      return Promise.resolve(vaultRows);
    }
    return Promise.resolve([]);
  };

  try {
    const summary = await getWorkspaceProviderSettings(mockSql, "org-test-1");
    assert.ok(summary.jev);
    assert.ok(summary.perception);
    assert.ok(summary.sources);
    assert.ok(summary.production);
    assert.ok(summary.storage);
    assert.ok(summary.cyclone);

    // Verify secrets are never exposed in settings summary
    for (const [cat, s] of Object.entries(summary)) {
      assert.equal((s.settings as any).apiKey, undefined, `${cat} should never expose raw apiKey`);
      assert.equal((s.settings as any).secret, undefined, `${cat} should never expose raw secret`);
      assert.equal((s.settings as any).password, undefined, `${cat} should never expose raw password`);
    }
  } finally {
    process.env.TOKEN_ENCRYPTION_KEY = originalKey;
  }
});

test("ProviderConfigService: prevents SSRF on configurable endpoints", async () => {
  const originalKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-provider-settings";

  const mockSql: any = () => Promise.resolve([]);

  try {
    // Attempting to set an AWS metadata endpoint
    await assert.rejects(
      async () => {
        await saveWorkspaceProviderConfig(mockSql, {
          organizationId: "org-1",
          actorId: "user-1",
          category: "production",
          settings: {
            endpointUrl: "http://169.254.169.254/latest/meta-data/",
          },
        });
      },
      /Invalid URL for endpointUrl/
    );
  } finally {
    process.env.TOKEN_ENCRYPTION_KEY = originalKey;
  }
});

test("ProviderConfigService: saves encrypted credential and writes audit log without raw secrets", async () => {
  const originalKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-provider-settings";

  const executedQueries: Array<{ query: string; values: any[] }> = [];

  const mockSql: any = (strings: TemplateStringsArray, ...values: any[]) => {
    const query = strings.join("?");
    executedQueries.push({ query, values });
    return Promise.resolve([]);
  };

  try {
    const result = await saveWorkspaceProviderConfig(mockSql, {
      organizationId: "org-secure-1",
      actorId: "admin-user",
      category: "jev",
      credentials: {
        apiKey: "sk-super-secret-key-12345",
      },
      settings: {
        mode: "typesafe_direct",
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.category, "jev");

    // Check that vault insert occurred
    const vaultInsert = executedQueries.find((q) => q.query.includes("insert into credential_vault"));
    assert.ok(vaultInsert, "Must insert encrypted credential into vault");

    // Check audit log query
    const auditInsert = executedQueries.find((q) => q.query.includes("insert into audit_log"));
    assert.ok(auditInsert, "Must write audit log entry");

    // Assert that the raw secret does not appear anywhere in values or metadata
    const auditValues = JSON.stringify(auditInsert.values);
    assert.ok(!auditValues.includes("sk-super-secret-key-12345"), "Raw secret must never be recorded in audit log");
  } finally {
    process.env.TOKEN_ENCRYPTION_KEY = originalKey;
  }
});
