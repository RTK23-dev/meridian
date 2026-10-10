import assert from "node:assert/strict";
import test from "node:test";
import { GeminiOmniVideoProvider } from "./providers/omni.ts";
import { productionCallContext } from "./call-context.ts";
import type { CreativeSpec } from "./types.ts";
import { storeVaultCredential } from "../vault/service.ts";
import { CREDENTIAL_VAULT_TYPE } from "../credentials/contract.ts";
import { fakeVaultSql, withEnv } from "../testing/fake-vault-sql.ts";

const WORKSPACE_KEY = "workspace-gemini-key-1234";
const DEPLOYMENT_KEY = "deployment-gemini-key-9876";

const spec: CreativeSpec = {
  id: "spec-tenant-1",
  organizationId: "org-a",
  brandId: "brand-a",
  title: "Tenant creative",
  modality: "video",
  format: "reel",
  aspectRatio: "9:16",
  durationTargetSeconds: 5,
  hookLine: "Hook",
  script: "Script",
  scenes: [],
};

/** Records the Gemini key header of every request. The answer is an error, because only the key is under test here. */
function recordingFetch(sent: Array<Record<string, string>>): typeof fetch {
  return (async (_url, init) => {
    sent.push((init?.headers as Record<string, string>) || {});
    return new Response(JSON.stringify({ error: "stub" }), { status: 500 });
  }) as typeof fetch;
}

const keyOf = (headers: Record<string, string>) => headers["x-goog-api-key"];

test("production runtime: each organization's Gemini call uses that organization's saved key only", async () => {
  await withEnv({}, async () => {
    const { sql } = fakeVaultSql();
    await storeVaultCredential(sql, "org-a", CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: WORKSPACE_KEY, customFields: {} });
    const sent: Array<Record<string, string>> = [];
    const omni = new GeminiOmniVideoProvider({ fetchImpl: recordingFetch(sent) });

    await omni.submitJob(spec, await productionCallContext(sql, "org-a"));
    assert.equal(sent.length, 1);
    assert.equal(keyOf(sent[0]), WORKSPACE_KEY, "org A's own key is used for org A");

    const other = await omni.submitJob({ ...spec, organizationId: "org-b" }, await productionCallContext(sql, "org-b"));
    assert.equal(sent.length, 1, "org B has no key, so no request is sent");
    assert.equal(other.status, "NOT_CONFIGURED");
  });
});

test("production runtime: a polled job uses its own organization's key", async () => {
  await withEnv({}, async () => {
    const { sql } = fakeVaultSql();
    await storeVaultCredential(sql, "org-a", CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: WORKSPACE_KEY, customFields: {} });
    const sent: Array<Record<string, string>> = [];
    const omni = new GeminiOmniVideoProvider({ fetchImpl: recordingFetch(sent) });

    await omni.checkJobStatus("interactions/tenant-poll-1", {}, await productionCallContext(sql, "org-a"));
    assert.equal(sent.length, 1);
    assert.equal(keyOf(sent[0]), WORKSPACE_KEY);

    const unpolled = await omni.checkJobStatus("interactions/tenant-poll-1", {}, await productionCallContext(sql, "org-b"));
    assert.equal(sent.length, 1, "another tenant's job is not polled with org A's key");
    assert.equal(unpolled.status, "NOT_CONFIGURED");
  });
});

test("production runtime: the deployment Gemini key is used only when the operator shares it", async () => {
  await withEnv({ MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_KEY }, async () => {
    const context = await productionCallContext(fakeVaultSql().sql, "org-none");
    assert.deepEqual(context, {}, "a deployment key without PRODUCTION_SHARED_DEFAULT is not a production key");
  });

  await withEnv({ MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_KEY, PRODUCTION_SHARED_DEFAULT: "deployment" }, async () => {
    const sent: Array<Record<string, string>> = [];
    const context = await productionCallContext(fakeVaultSql().sql, "org-none");
    assert.deepEqual(context, { googleKey: DEPLOYMENT_KEY });
    await new GeminiOmniVideoProvider({ fetchImpl: recordingFetch(sent) }).submitJob(spec, context);
    assert.equal(keyOf(sent[0]), DEPLOYMENT_KEY);
  });
});

test("production runtime: with no database connection no workspace key is read, and no request is sent", async () => {
  await withEnv({ PRODUCTION_SHARED_DEFAULT: "deployment", MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_KEY }, async () => {
    const sent: Array<Record<string, string>> = [];
    const context = await productionCallContext(undefined, "org-a");
    assert.deepEqual(context, {});
    const job = await new GeminiOmniVideoProvider({ fetchImpl: recordingFetch(sent) }).submitJob(spec, context);
    assert.equal(sent.length, 0);
    assert.equal(job.status, "NOT_CONFIGURED");
  });
});

test("production runtime: an expired saved key sends nothing, and the deployment key is not used in its place", async () => {
  await withEnv({ PRODUCTION_SHARED_DEFAULT: "deployment", MERIDIAN_GEMINI_API_KEY: DEPLOYMENT_KEY }, async () => {
    const { sql, rows } = fakeVaultSql();
    await storeVaultCredential(sql, "org-a", CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: WORKSPACE_KEY, customFields: {} });
    rows[0].expires_at = "2020-01-01T00:00:00.000Z";
    const sent: Array<Record<string, string>> = [];
    const context = await productionCallContext(sql, "org-a");
    assert.deepEqual(context, {});
    const job = await new GeminiOmniVideoProvider({ fetchImpl: recordingFetch(sent) }).submitJob(spec, context);
    assert.equal(sent.length, 0, "no request with the deployment key");
    assert.equal(job.status, "NOT_CONFIGURED");
  });
});
