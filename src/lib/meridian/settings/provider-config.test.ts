import assert from "node:assert/strict";
import test from "node:test";
import {
  getWorkspaceProviderSettings,
  saveWorkspaceProviderConfig,
} from "./provider-config.ts";

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
