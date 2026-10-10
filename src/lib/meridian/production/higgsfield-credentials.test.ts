import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { HiggsfieldProvider } from "./providers/higgsfield.ts";
import { ProductionRouter } from "./router.ts";
import type { CreativeSpec } from "./types.ts";
import { CREDENTIAL_VAULT_TYPE } from "../credentials/contract.ts";
import { openTestBackends, withEnv } from "../credentials/test-databases.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { storeVaultCredential } from "../vault/service.ts";

// Used only by this test process: the vault encrypts saved keys with this master key.
process.env.TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-higgsfield-credentials";

const backends = await openTestBackends();
after(async () => {
  for (const backend of backends) await backend.close();
});

const DEPLOYMENT_HIGGSFIELD = "deployment-higgsfield-key-7654";

/** A fetch that records each request's headers. A test asserts on them to see which key Higgsfield received, and whether any. */
function recorder() {
  const requests: Headers[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ request_id: "hf-acceptance-1", status_url: "https://api.higgsfield.ai/v1/requests/hf-acceptance-1/status", status: "queued" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { requests, fetchImpl };
}

function specFor(tenant: { organizationId: string; brandId: string }): CreativeSpec {
  return {
    id: `spec-${randomUUID()}`,
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    title: "Higgsfield acceptance",
    modality: "video",
    format: "reel",
    aspectRatio: "9:16",
    durationTargetSeconds: 5,
    hookLine: "Stop scrolling!",
    script: "Here is the proof.",
    scenes: [{ index: 0, description: "Opening shot", durationSeconds: 5 }],
  };
}

for (const { name, sql } of backends) {
  test(`[${name}] Higgsfield is never ready from the environment alone: without a workspace, or without the flag, it is NOT_CONFIGURED`, async () => {
    const tenant = await studioTenant(sql, "hf-noflag");
    const rec = recorder();
    const provider = new HiggsfieldProvider({ sql, fetchImpl: rec.fetchImpl });

    await withEnv({ HIGGSFIELD_API_KEY: DEPLOYMENT_HIGGSFIELD }, async () => {
      const bare = await provider.health();
      assert.equal(bare.state, "NOT_CONFIGURED", "without a workspace, health never reports CONFIGURED");

      const forWorkspace = await provider.healthFor(tenant.organizationId);
      assert.equal(forWorkspace.state, "NOT_CONFIGURED", "without the flag, the deployment key is not used for any workspace");
      assert.match(forWorkspace.detail, /PRODUCTION_SHARED_DEFAULT=deployment/);

      const job = await provider.submitJob(specFor(tenant));
      assert.equal(job.status, "NOT_CONFIGURED");
      assert.equal(rec.requests.length, 0, "no request is sent without the flag");
    });
  });

  test(`[${name}] Higgsfield uses the deployment key only when PRODUCTION_SHARED_DEFAULT=deployment is set`, async () => {
    const tenant = await studioTenant(sql, "hf-flag");
    const rec = recorder();
    const provider = new HiggsfieldProvider({ sql, fetchImpl: rec.fetchImpl });

    await withEnv({ PRODUCTION_SHARED_DEFAULT: "deployment", HIGGSFIELD_API_KEY: DEPLOYMENT_HIGGSFIELD }, async () => {
      assert.equal((await provider.healthFor(tenant.organizationId)).state, "CONFIGURED");
      const job = await provider.submitJob(specFor(tenant));
      assert.equal(job.status, "QUEUED");
      assert.equal(rec.requests.length, 1);
      assert.equal(rec.requests[0].get("authorization"), `Key ${DEPLOYMENT_HIGGSFIELD}`);
      assert.equal(job.metadata?.organizationId, tenant.organizationId, "the job records the workspace that owns it");
    });
  });

  test(`[${name}] Higgsfield never stands in for an unusable saved production entry, even with the flag set`, async () => {
    const tenant = await studioTenant(sql, "hf-expired");
    await storeVaultCredential(sql, tenant.organizationId, CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: "expired-production-key-8888" }, { expiresAt: new Date(Date.now() - 60_000) });
    const rec = recorder();
    const provider = new HiggsfieldProvider({ sql, fetchImpl: rec.fetchImpl });

    await withEnv({ PRODUCTION_SHARED_DEFAULT: "deployment", HIGGSFIELD_API_KEY: DEPLOYMENT_HIGGSFIELD }, async () => {
      const health = await provider.healthFor(tenant.organizationId);
      assert.equal(health.state, "NOT_CONFIGURED");
      assert.match(health.detail, /expired/);
      assert.equal(health.detail.includes(DEPLOYMENT_HIGGSFIELD), false);

      const job = await provider.submitJob(specFor(tenant));
      assert.equal(job.status, "NOT_CONFIGURED");
      assert.equal(rec.requests.length, 0, "no request is sent for a workspace whose saved entry is unusable");
    });
  });

  test(`[${name}] BALANCED routing does not pick Higgsfield for a workspace whose saved production entry is expired, even with the flag`, async () => {
    const expired = await studioTenant(sql, "hf-route-expired");
    await storeVaultCredential(sql, expired.organizationId, CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: "expired-route-key-9999" }, { expiresAt: new Date(Date.now() - 60_000) });
    const rec = recorder();
    const router = new ProductionRouter({
      runtime: "production",
      providers: [new HiggsfieldProvider({ sql, fetchImpl: rec.fetchImpl })],
      imageProviders: [],
    });

    await withEnv({ PRODUCTION_SHARED_DEFAULT: "deployment", HIGGSFIELD_API_KEY: DEPLOYMENT_HIGGSFIELD }, async () => {
      await assert.rejects(
        router.selectForSpec(specFor(expired), "BALANCED"),
        /No configured production providers available for mode BALANCED/,
        "the only candidate is not ready for this workspace, so nothing is selected",
      );
      await assert.rejects(router.routeExplicit("higgsfield", specFor(expired)), /NOT_CONFIGURED: .*expired/, "an explicit choice is refused too");
      assert.equal(rec.requests.length, 0, "routing sends no request");
    });
  });

  test(`[${name}] BALANCED routing picks Higgsfield for a workspace with no saved entry, when the flag is set`, async () => {
    const tenant = await studioTenant(sql, "hf-route-open");
    const rec = recorder();
    const router = new ProductionRouter({
      runtime: "production",
      providers: [new HiggsfieldProvider({ sql, fetchImpl: rec.fetchImpl })],
      imageProviders: [],
    });

    await withEnv({ PRODUCTION_SHARED_DEFAULT: "deployment", HIGGSFIELD_API_KEY: DEPLOYMENT_HIGGSFIELD }, async () => {
      const selection = await router.selectForSpec(specFor(tenant), "BALANCED");
      assert.equal(selection.provider.id, "higgsfield");
      assert.equal(rec.requests.length, 0, "selection sends no request");
    });
  });
}
