import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCredential, sharedDefaultOptedIn } from "./resolve.ts";
import { CREDENTIAL_VAULT_TYPE, credentialStateOf, type CredentialCategory } from "./contract.ts";
import { openTestBackends, vaultRowId, withEnv } from "./test-databases.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { retrieveVaultCredential, storeVaultCredential } from "../vault/service.ts";

// Used only by this test process: the vault encrypts saved keys with this master key.
process.env.TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-credential-resolution";

const backends = await openTestBackends();
after(async () => {
  for (const backend of backends) await backend.close();
});

const DEPLOYMENT_GEMINI = "deployment-gemini-key-9999";
const DEPLOYMENT_TYPESAFE = "deployment-typesafe-key-8888";

for (const { name, sql } of backends) {
  test(`[${name}] a usable workspace key is the one resolved, and another workspace never receives it`, async () => {
    const a = await studioTenant(sql, "res-a");
    const b = await studioTenant(sql, "res-b");
    await storeVaultCredential(sql, a.organizationId, CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: "workspace-a-key-1111" });

    await withEnv({ PRODUCTION_SHARED_DEFAULT: "deployment", MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_GEMINI }, async () => {
      const mine = await resolveCredential(sql, a.organizationId, "production");
      assert.equal(mine.status, "ready");
      if (mine.status === "ready") {
        assert.equal(mine.source, "workspace");
        assert.equal(mine.secret, "workspace-a-key-1111");
        assert.equal(mine.fingerprint, "...1111");
      }

      // Workspace B has no saved key. With the shared default on, it gets the deployment key, never workspace A's.
      const theirs = await resolveCredential(sql, b.organizationId, "production");
      assert.equal(theirs.status, "ready");
      if (theirs.status === "ready") {
        assert.equal(theirs.source, "deployment_shared_default");
        assert.equal(theirs.secret, DEPLOYMENT_GEMINI);
        assert.notEqual(theirs.secret, "workspace-a-key-1111");
      }
    });
  });

  test(`[${name}] tenant isolation: workspace B cannot read workspace A's saved key by its row id`, async () => {
    const a = await studioTenant(sql, "iso-a");
    const b = await studioTenant(sql, "iso-b");
    await storeVaultCredential(sql, a.organizationId, CREDENTIAL_VAULT_TYPE.jev, { accessToken: "", apiKey: "isolated-jev-key-2222" });
    const rowId = await vaultRowId(sql, a.organizationId, CREDENTIAL_VAULT_TYPE.jev);
    assert.ok(rowId, "workspace A has a saved entry");

    await withEnv({}, async () => {
      assert.equal(await retrieveVaultCredential(sql, b.organizationId, rowId!), null, "the vault read is scoped to the owner");
      const other = await resolveCredential(sql, b.organizationId, "jev");
      assert.equal(other.status, "not_configured", "with no shared default, workspace B has nothing to use");
      assert.equal(JSON.stringify(other).includes("isolated-jev-key-2222"), false);
    });
  });

  test(`[${name}] fail closed: an expired, unreadable or empty saved key is unusable, and never falls back to the shared default`, async () => {
    const cases: Array<{
      label: string;
      category: CredentialCategory;
      sharedEnv: Record<string, string>;
      prepare: (organizationId: string) => Promise<void>;
      reason: RegExp;
    }> = [
      {
        label: "expired",
        category: "production",
        sharedEnv: { PRODUCTION_SHARED_DEFAULT: "deployment", MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_GEMINI },
        prepare: async (organizationId) => {
          await storeVaultCredential(sql, organizationId, CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: "expired-key-3333" }, { expiresAt: new Date(Date.now() - 60_000) });
        },
        reason: /expired/,
      },
      {
        label: "unreadable (corrupt ciphertext)",
        category: "production",
        sharedEnv: { PRODUCTION_SHARED_DEFAULT: "deployment", MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_GEMINI },
        prepare: async (organizationId) => {
          await storeVaultCredential(sql, organizationId, CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: "corrupt-key-4444" });
          const rowId = await vaultRowId(sql, organizationId, CREDENTIAL_VAULT_TYPE.production);
          await sql.query("update credential_vault set ciphertext = $1 where id = $2", ["AAAA", rowId]);
        },
        reason: /could not be read/,
      },
      {
        label: "empty",
        category: "production",
        sharedEnv: { PRODUCTION_SHARED_DEFAULT: "deployment", MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_GEMINI },
        prepare: async (organizationId) => {
          await storeVaultCredential(sql, organizationId, CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: "" });
        },
        reason: /holds no key/,
      },
      {
        label: "expired JEV key, with the TypeSafe shared default on",
        category: "jev",
        sharedEnv: { JEV_SHARED_DEFAULT: "deployment", TYPESAFE_JEV_API_KEY: DEPLOYMENT_TYPESAFE },
        prepare: async (organizationId) => {
          await storeVaultCredential(sql, organizationId, CREDENTIAL_VAULT_TYPE.jev, { accessToken: "", apiKey: "expired-jev-5555" }, { expiresAt: new Date(Date.now() - 60_000) });
        },
        reason: /expired/,
      },
    ];

    for (const testCase of cases) {
      const tenant = await studioTenant(sql, `fail-${testCase.label.replace(/\W+/g, "-")}`);
      await testCase.prepare(tenant.organizationId);
      await withEnv(testCase.sharedEnv, async () => {
        const resolution = await resolveCredential(sql, tenant.organizationId, testCase.category);
        assert.equal(resolution.status, "unusable", `${testCase.label}: unusable`);
        assert.match(resolution.status === "unusable" ? resolution.reason : "", testCase.reason, testCase.label);
        assert.notEqual(resolution.status, "ready", `${testCase.label}: the shared default is never used in its place`);
        const state = credentialStateOf(resolution);
        assert.equal(state.state, "unusable");
        assert.equal(state.fingerprint, null);
        assert.equal(JSON.stringify(state).includes(DEPLOYMENT_GEMINI), false);
        assert.equal(JSON.stringify(state).includes(DEPLOYMENT_TYPESAFE), false);
      });
    }
  });

  test(`[${name}] shared default: used only when opted in, and reported as the deployment shared default`, async () => {
    const tenant = await studioTenant(sql, "shared");
    await withEnv({ MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_GEMINI }, async () => {
      const notShared = await resolveCredential(sql, tenant.organizationId, "production");
      assert.equal(notShared.status, "not_configured", "a deployment key alone is not used");
      assert.match(notShared.status === "not_configured" ? notShared.reason : "", /does not share one/);
    });
    await withEnv({ PRODUCTION_SHARED_DEFAULT: "true", MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_GEMINI }, async () => {
      assert.equal((await resolveCredential(sql, tenant.organizationId, "production")).status, "not_configured", "only the accepted value opts in");
    });
    await withEnv({ PRODUCTION_SHARED_DEFAULT: "deployment", MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_GEMINI }, async () => {
      const shared = await resolveCredential(sql, tenant.organizationId, "production");
      assert.equal(shared.status === "ready" && shared.source, "deployment_shared_default");
      assert.equal(shared.status === "ready" && shared.fingerprint, "...9999");
    });
    await withEnv({ PRODUCTION_SHARED_DEFAULT: "deployment" }, async () => {
      const noKey = await resolveCredential(sql, tenant.organizationId, "production");
      assert.equal(noKey.status, "not_configured", "opted in, but the deployment has no key");
    });
    await withEnv({ JEV_SHARED_DEFAULT: "deployment", TYPESAFE_JEV_API_KEY: DEPLOYMENT_TYPESAFE }, async () => {
      const jev = await resolveCredential(sql, tenant.organizationId, "jev");
      assert.equal(jev.status === "ready" && jev.secret, DEPLOYMENT_TYPESAFE);
      assert.equal(sharedDefaultOptedIn("jev"), true);
    });
    await withEnv({ PERCEPTION_SHARED_DEFAULT: "gemini", MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_GEMINI }, async () => {
      const perception = await resolveCredential(sql, tenant.organizationId, "perception");
      assert.equal(perception.status === "ready" && perception.source, "deployment_shared_default");
    });
  });

  test(`[${name}] redaction: a state never carries the raw key, and a short key shows no fingerprint`, async () => {
    const long = await studioTenant(sql, "redact-long");
    const short = await studioTenant(sql, "redact-short");
    await storeVaultCredential(sql, long.organizationId, CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: "a-long-workspace-key-7777" });
    await storeVaultCredential(sql, short.organizationId, CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: "short1" });

    await withEnv({}, async () => {
      const longState = credentialStateOf(await resolveCredential(sql, long.organizationId, "production"));
      assert.equal(longState.state, "usable");
      assert.equal(longState.fingerprint, "...7777");
      assert.equal(JSON.stringify(longState).includes("a-long-workspace-key-7777"), false);

      const shortState = credentialStateOf(await resolveCredential(sql, short.organizationId, "production"));
      assert.equal(shortState.state, "usable", "a short key is still usable");
      assert.ok(!shortState.fingerprint, "a key shorter than eight characters shows no fingerprint");
      assert.equal(JSON.stringify(shortState).includes("short1"), false);
    });
  });

  test(`[${name}] no workspace in scope: nothing is read, and nothing is used`, async () => {
    await withEnv({ PRODUCTION_SHARED_DEFAULT: "deployment", MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_GEMINI }, async () => {
      const resolution = await resolveCredential(sql, "", "production");
      assert.equal(resolution.status, "not_configured");
      assert.match(resolution.status === "not_configured" ? resolution.reason : "", /No workspace is in scope/);
    });
  });
}

test("no Google or TypeSafe provider key is read from the environment outside the resolver", () => {
  // The resolver, the Google alias table it relies on, and the JEV config value are the only places allowed to name these.
  // The YouTube distribution key is outside workstream A and is reported, not changed, by it.
  const allowed = new Set([
    // The test helper lists these names only to clear them between tests. It reads no key.
    "lib/meridian/credentials/test-databases.ts",
    "lib/meridian/credentials/resolve.ts",
    "lib/meridian/config/resolver.ts",
    "lib/meridian/jev/config.ts",
    "lib/meridian/distribution/youtube.ts",
    // The integrations screen names the variable an operator should set, in its setup guidance. It reads no key.
    "components/settings/integration-model.ts",
  ]);
  const names = /MERIDIAN_GEMINI_API_KEY|GOOGLE_AI_STUDIO_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|TYPESAFE_JEV_API_KEY|TYPESAFE_API_KEY|HIGGSFIELD_API_KEY/;
  const srcRoot = fileURLToPath(new URL("../../../", import.meta.url)); // src/
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry) || /\.test\.ts$/.test(entry)) continue;
      const rel = relative(srcRoot, path);
      if (allowed.has(rel)) continue;
      if (names.test(readFileSync(path, "utf8"))) offenders.push(rel);
    }
  };
  walk(srcRoot);
  assert.deepEqual(offenders, [], "a provider key is read from the environment outside the resolver");
});
