import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { storeVaultCredential } from "../vault/service.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { PERCEPTION_CREDENTIAL_TYPE, fingerprintOf, resolvePerceptionCredential } from "./credential.ts";
import { perceptionReadiness } from "./run.ts";
import { GeminiPerceptionProvider } from "./multimodal.ts";
import { readFileSync } from "node:fs";

// Used only by this test process: the vault encrypts saved keys with this master key.
process.env.TOKEN_ENCRYPTION_KEY = "test-master-key-0123456789abcdef-test";
const SHARED_KEY = "shared-deployment-key-9876";

function env(extra: Record<string, string | undefined> = {}) {
  return { MERIDIAN_GEMINI_API_KEY: undefined, PERCEPTION_SHARED_DEFAULT: undefined, ...extra };
}

test("a workspace's own saved key is used first, and only for that workspace", async () => {
  const sql = await getSql();
  const owner = await studioTenant(sql, "credential-workspace");
  const other = await studioTenant(sql, "credential-other");
  await storeVaultCredential(sql, owner.organizationId, PERCEPTION_CREDENTIAL_TYPE, { accessToken: "", apiKey: "workspace-key-1111" });
  const mine = await resolvePerceptionCredential(sql, owner.organizationId, env({ PERCEPTION_SHARED_DEFAULT: "gemini", MERIDIAN_GEMINI_API_KEY: SHARED_KEY }));
  assert.equal(mine.status, "ready");
  if (mine.status === "ready") {
    assert.equal(mine.source, "workspace", "the workspace's own key wins over the shared default");
    assert.equal(mine.apiKey, "workspace-key-1111");
    assert.equal(mine.fingerprint, "...1111", "only the masked fingerprint leaves the resolver");
  }
  const theirs = await resolvePerceptionCredential(sql, other.organizationId, env({ PERCEPTION_SHARED_DEFAULT: "gemini", MERIDIAN_GEMINI_API_KEY: SHARED_KEY }));
  assert.equal(theirs.status === "ready" && theirs.apiKey, SHARED_KEY, "another workspace never sees the first workspace's key");
});

test("a saved entry that holds no key is unusable, and is not silently replaced by the shared default", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "credential-empty");
  await storeVaultCredential(sql, tenant.organizationId, PERCEPTION_CREDENTIAL_TYPE, { accessToken: "", apiKey: "", customFields: { note: "x" } });
  const resolved = await resolvePerceptionCredential(sql, tenant.organizationId, env({ PERCEPTION_SHARED_DEFAULT: "gemini", MERIDIAN_GEMINI_API_KEY: SHARED_KEY }));
  assert.equal(resolved.status, "unusable", "a stored credential that cannot be used is reported, not ignored");
  assert.equal(resolved.status === "unusable" && resolved.source, "workspace");
});

test("an expired saved key is unusable", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "credential-expired");
  await storeVaultCredential(sql, tenant.organizationId, PERCEPTION_CREDENTIAL_TYPE, { accessToken: "", apiKey: "expired-key-2222" }, { expiresAt: new Date(Date.now() - 60_000) });
  const resolved = await resolvePerceptionCredential(sql, tenant.organizationId, env());
  assert.equal(resolved.status, "unusable");
  assert.match(resolved.status === "unusable" ? resolved.reason : "", /expired/);
});

test("a saved key that cannot be read is unusable, not treated as absent", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "credential-unreadable");
  await storeVaultCredential(sql, tenant.organizationId, PERCEPTION_CREDENTIAL_TYPE, { accessToken: "", apiKey: "sealed-key-3333" }, { masterKey: "a-different-master-key-entirely" });
  const resolved = await resolvePerceptionCredential(sql, tenant.organizationId, env({ PERCEPTION_SHARED_DEFAULT: "gemini", MERIDIAN_GEMINI_API_KEY: SHARED_KEY }));
  assert.equal(resolved.status, "unusable");
  assert.match(resolved.status === "unusable" ? resolved.reason : "", /could not be read/);
});

test("with no saved key, the deployment key is used only when it is set as the intentional shared default", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "credential-shared");
  const notShared = await resolvePerceptionCredential(sql, tenant.organizationId, env({ MERIDIAN_GEMINI_API_KEY: SHARED_KEY }));
  assert.equal(notShared.status, "not_configured", "a deployment key alone is not used for perception");
  const sharedButNoKey = await resolvePerceptionCredential(sql, tenant.organizationId, env({ PERCEPTION_SHARED_DEFAULT: "gemini" }));
  assert.equal(sharedButNoKey.status, "not_configured");
  const shared = await resolvePerceptionCredential(sql, tenant.organizationId, env({ PERCEPTION_SHARED_DEFAULT: "gemini", MERIDIAN_GEMINI_API_KEY: SHARED_KEY }));
  assert.equal(shared.status === "ready" && shared.source, "deployment_shared_default");
  assert.equal(shared.status === "ready" && shared.fingerprint, "...9876");
});

test("readiness and the provider's production call use the same credential: a ready check is never a lie about the run", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "credential-readiness");
  const provider = new GeminiPerceptionProvider("gemini-test", { fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "[]" }] } }] }) })) as unknown as typeof fetch });
  const previous = { ...process.env };
  try {
    delete process.env.PERCEPTION_SHARED_DEFAULT;
    delete process.env.MERIDIAN_GEMINI_API_KEY;
    delete process.env.GOOGLE_AI_STUDIO_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    const off = await perceptionReadiness(sql, tenant.organizationId, provider);
    assert.equal(off.ready, false, "no credential, so not ready");
    await storeVaultCredential(sql, tenant.organizationId, PERCEPTION_CREDENTIAL_TYPE, { accessToken: "", apiKey: "readiness-key-4444" });
    const on = await perceptionReadiness(sql, tenant.organizationId, provider);
    assert.equal(on.ready, true);
    assert.equal(on.source, "workspace");
    assert.equal(await perceptionReadiness(sql, tenant.organizationId, null).then((item) => item.ready), false, "no provider, not ready");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test("the settings summary reads perception through the one resolver, and never from a provider key in the environment", () => {
  const source = readFileSync(new URL("../settings/provider-config.ts", import.meta.url), "utf8");
  assert.match(source, /perceptionStateFor\(/, "the summary reads perception through the resolver");
  assert.match(source, /resolveCredential\(/, "the summary calls the shared resolver");
  assert.doesNotMatch(source, /process\.env\.(MERIDIAN_GEMINI_API_KEY|GOOGLE_AI_STUDIO_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|TYPESAFE_JEV_API_KEY)/, "no provider key is read from the environment here");
});

test("fingerprintOf never returns the key itself", () => {
  assert.equal(fingerprintOf("abcdefgh"), "...efgh");
  assert.equal(fingerprintOf("ab"), "...");
  assert.equal(fingerprintOf("abcd"), "...", "a four-character key is shown whole by the last four, so it is hidden entirely");
  assert.equal(fingerprintOf("abcdefg"), "...", "fewer than eight characters: nothing is shown");
  assert.ok(!fingerprintOf("supersecretvalue").includes("supersecret"));
});
