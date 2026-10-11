import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { JevRouter, OpenRouterJevProvider, TypeSafeDirectJevProvider } from "../jev/router.ts";
import { OpenRouterJevClient } from "../jev/client.ts";
import type { JevDecisionRequest } from "../jev/types.ts";
import { GeminiOmniVideoProvider } from "../production/providers/omni.ts";
import { GoogleNanoBananaImageProvider } from "../production/image-providers.ts";
import { ProductionRouter } from "../production/router.ts";
import { JevDecisionEngine } from "../decisions/jev-engine.ts";
import { createDecisionEngines } from "../decisions/dispatcher.ts";
import { getDecisionEngineStatus } from "../decisions/status.ts";
import type { CreativeSpec } from "../production/types.ts";
import { CREDENTIAL_VAULT_TYPE } from "./contract.ts";
import { openTestBackends, withEnv } from "./test-databases.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { storeVaultCredential } from "../vault/service.ts";

// Used only by this test process: the vault encrypts saved keys with this master key.
process.env.TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-adapter-acceptance";

const backends = await openTestBackends();
after(async () => {
  for (const backend of backends) await backend.close();
});

/**
 * A fetch that records every request's headers and counts the calls. A test asserts on these to see which key an adapter
 * sent, and whether it sent anything at all.
 */
function recorder(respond: () => Response) {
  const requests: Headers[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(new Headers(init?.headers));
    return respond();
  }) as unknown as typeof fetch;
  return { requests, calls: () => requests.length, fetchImpl };
}

const jevResponse = () => new Response(JSON.stringify({ model: "typesafe/jev-1.13", answers: {} }), { status: 200 });
const omniResponse = () => new Response(JSON.stringify({ interaction_id: "interactions/acceptance-1", status: "in_progress", steps: [] }), { status: 200 });
const imageRefused = () => new Response("refused", { status: 403 });

function jevRequest(organizationId: string): JevDecisionRequest {
  return {
    organizationId,
    brandId: "brand-acceptance",
    // A unique description keeps this request out of any earlier decision cache in this process.
    state: { description: `acceptance ${randomUUID()}` },
    questions: {
      "acceptance.hook": {
        id: "acceptance.hook",
        version: "1.0",
        type: "noul",
        instructions: "Is this a scroll stopper?",
        criteria: { true: "yes", false: "no" },
        evidenceRequirements: [],
      },
    },
  };
}

function specFor(tenant: { organizationId: string; brandId: string }): CreativeSpec {
  return {
    id: `spec-${randomUUID()}`,
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    title: "Acceptance creative",
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
  test(`[${name}] JEV: the adapter sends the workspace's own key, and another workspace's request sends nothing`, async () => {
    const a = await studioTenant(sql, "jev-a");
    const b = await studioTenant(sql, "jev-b");
    await storeVaultCredential(sql, a.organizationId, CREDENTIAL_VAULT_TYPE.jev, { accessToken: "", apiKey: "jev-workspace-key-1111" });

    await withEnv({}, async () => {
      const rec = recorder(jevResponse);
      const router = new JevRouter({ typesafeProvider: new TypeSafeDirectJevProvider({ sql, fetchImpl: rec.fetchImpl }) });
      await router.decide(jevRequest(a.organizationId), { mode: "auto", preferredProvider: "typesafe_direct", fallbackEnabled: false });
      assert.equal(rec.calls(), 1);
      assert.equal(rec.requests[0].get("authorization"), "Bearer jev-workspace-key-1111");

      // Workspace B has no saved key and no shared default. Its request is answered not_configured, and no request is sent.
      const answered = await router.decide(jevRequest(b.organizationId), { mode: "auto", preferredProvider: "typesafe_direct", fallbackEnabled: false });
      assert.equal(rec.calls(), 1, "no request for a workspace with no usable key");
      assert.equal(answered.answers["acceptance.hook"].status, "not_configured");
    });
  });

  test(`[${name}] JEV: each workspace's request carries its own key, never another workspace's`, async () => {
    const a = await studioTenant(sql, "jev-own-a");
    const b = await studioTenant(sql, "jev-own-b");
    await storeVaultCredential(sql, a.organizationId, CREDENTIAL_VAULT_TYPE.jev, { accessToken: "", apiKey: "jev-own-key-aaaa" });
    await storeVaultCredential(sql, b.organizationId, CREDENTIAL_VAULT_TYPE.jev, { accessToken: "", apiKey: "jev-own-key-bbbb" });

    await withEnv({}, async () => {
      const rec = recorder(jevResponse);
      const provider = new TypeSafeDirectJevProvider({ sql, fetchImpl: rec.fetchImpl });
      await provider.decide(jevRequest(a.organizationId));
      await provider.decide(jevRequest(b.organizationId));
      assert.equal(rec.requests[0].get("authorization"), "Bearer jev-own-key-aaaa");
      assert.equal(rec.requests[1].get("authorization"), "Bearer jev-own-key-bbbb");
    });
  });

  test(`[${name}] JEV: an unusable saved key sends nothing, even with the TypeSafe shared default on`, async () => {
    const tenant = await studioTenant(sql, "jev-unusable");
    await storeVaultCredential(sql, tenant.organizationId, CREDENTIAL_VAULT_TYPE.jev, { accessToken: "", apiKey: "" });

    await withEnv({ JEV_SHARED_DEFAULT: "deployment", TYPESAFE_JEV_API_KEY: "deployment-typesafe-key-2222" }, async () => {
      const rec = recorder(jevResponse);
      const provider = new TypeSafeDirectJevProvider({ sql, fetchImpl: rec.fetchImpl });
      const res = await provider.decide(jevRequest(tenant.organizationId));
      assert.equal(rec.calls(), 0, "no request is sent");
      assert.equal(res.answers["acceptance.hook"].status, "not_configured");
      // An unusable saved entry is reported as UNAVAILABLE, not NOT_CONFIGURED. NOT_CONFIGURED means the workspace has no
      // entry at all, which is the only case where another transport may be tried. The entry is the workspace's own, so it
      // is unavailable, and nothing is sent for it, which the assertion above still checks.
      assert.equal((await provider.healthFor(tenant.organizationId)).status, "UNAVAILABLE");
    });
  });

  test(`[${name}] JEV: the deployment TypeSafe key is sent only when JEV_SHARED_DEFAULT=deployment is set`, async () => {
    const tenant = await studioTenant(sql, "jev-deployment");
    const rec = recorder(jevResponse);
    const provider = new TypeSafeDirectJevProvider({ sql, fetchImpl: rec.fetchImpl });

    await withEnv({ TYPESAFE_JEV_API_KEY: "deployment-typesafe-key-3333" }, async () => {
      await provider.decide(jevRequest(tenant.organizationId));
      assert.equal(rec.calls(), 0, "a deployment key alone is not used for JEV");
    });
    await withEnv({ JEV_SHARED_DEFAULT: "deployment", TYPESAFE_JEV_API_KEY: "deployment-typesafe-key-3333" }, async () => {
      await provider.decide(jevRequest(tenant.organizationId));
      assert.equal(rec.calls(), 1);
      assert.equal(rec.requests[0].get("authorization"), "Bearer deployment-typesafe-key-3333");
    });
  });

  test(`[${name}] OpenRouter: deployment-only, and it sends nothing unless JEV_SHARED_DEFAULT=deployment is set`, async () => {
    const rec = recorder(jevResponse);
    const client = new OpenRouterJevClient({ apiKey: "openrouter-deployment-key-4444", fetchImpl: rec.fetchImpl });
    const provider = new OpenRouterJevProvider(client);

    await withEnv({ OPENROUTER_API_KEY: "openrouter-deployment-key-4444" }, async () => {
      const health = await provider.health();
      assert.equal(health.status, "NOT_CONFIGURED");
      assert.match(health.status === "NOT_CONFIGURED" ? health.message : "", /JEV_SHARED_DEFAULT=deployment/);
      const res = await provider.decide(jevRequest("org-openrouter"));
      assert.equal(rec.calls(), 0, "not opted in: no request");
      assert.equal(res.answers["acceptance.hook"].status, "not_configured");
    });

    await withEnv({ JEV_SHARED_DEFAULT: "deployment", OPENROUTER_API_KEY: "openrouter-deployment-key-4444" }, async () => {
      assert.equal((await provider.health()).status, "READY");
      await provider.decide(jevRequest("org-openrouter"));
      assert.equal(rec.calls(), 1, "opted in: the deployment key is used");
      assert.equal(rec.requests[0].get("authorization"), "Bearer openrouter-deployment-key-4444");
    });
  });

  test(`[${name}] Omni: the submit and the poll send the owning workspace's key, and another workspace's job sends nothing`, async () => {
    const a = await studioTenant(sql, "omni-a");
    const b = await studioTenant(sql, "omni-b");
    await storeVaultCredential(sql, a.organizationId, CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: "omni-workspace-key-1111" });

    await withEnv({}, async () => {
      const rec = recorder(omniResponse);
      const provider = new GeminiOmniVideoProvider({ sql, fetchImpl: rec.fetchImpl });

      const submitted = await provider.submitJob(specFor(a));
      assert.equal(submitted.status, "RUNNING");
      assert.equal(rec.requests[0].get("x-goog-api-key"), "omni-workspace-key-1111");

      const polled = await provider.checkJobStatus("interactions/acceptance-1", { organizationId: a.organizationId });
      assert.equal(polled.status, "RUNNING");
      assert.equal(rec.requests[1].get("x-goog-api-key"), "omni-workspace-key-1111");

      const refused = await provider.submitJob(specFor(b));
      assert.equal(refused.status, "NOT_CONFIGURED");
      const foreignPoll = await provider.checkJobStatus("interactions/acceptance-1", { organizationId: b.organizationId });
      assert.equal(foreignPoll.status, "NOT_CONFIGURED", "a poll for workspace B is never answered with A's key");
      assert.equal(rec.calls(), 2, "workspace B made no request, for the submit or the poll");
    });
  });

  test(`[${name}] Google image: the generator sends the owning workspace's key, and sends nothing without a usable one`, async () => {
    const a = await studioTenant(sql, "image-a");
    const b = await studioTenant(sql, "image-b");
    await storeVaultCredential(sql, a.organizationId, CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: "image-workspace-key-1111" });

    await withEnv({}, async () => {
      const rec = recorder(imageRefused);
      const provider = new GoogleNanoBananaImageProvider({ sql, fetchImpl: rec.fetchImpl });
      const input = { prompt: "brand-safe product", seed: `seed-${randomUUID()}`, promptVersion: "v1", model: "gemini-nano-banana-2.1", aspectRatio: "9:16" };

      await provider.generate({ ...input, organizationId: a.organizationId });
      assert.equal(rec.requests[0].get("x-goog-api-key"), "image-workspace-key-1111");

      const notForB = await provider.generate({ ...input, organizationId: b.organizationId });
      assert.equal(notForB.status, "NOT_CONNECTED");

      const noWorkspace = await provider.generate(input);
      assert.equal(noWorkspace.status, "NOT_CONNECTED");
      assert.equal(rec.calls(), 1, "no request for workspace B, or for a call with no workspace");

      // Readiness is per workspace. Without a workspace, the image provider never reports READY.
      assert.equal((await provider.health()).state, "NOT_CONFIGURED");
      assert.equal((await provider.healthFor(a.organizationId)).state, "CONFIGURED");
      assert.equal((await provider.healthFor(b.organizationId)).state, "NOT_CONFIGURED");
    });
  });

  test(`[${name}] production routing: an explicit provider is judged for the spec's workspace, not for no workspace`, async () => {
    const a = await studioTenant(sql, "route-a");
    const b = await studioTenant(sql, "route-b");
    await storeVaultCredential(sql, a.organizationId, CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: "route-workspace-key-1111" });

    await withEnv({}, async () => {
      const rec = recorder(omniResponse);
      const router = new ProductionRouter({
        runtime: "production",
        providers: [new GeminiOmniVideoProvider({ sql, fetchImpl: rec.fetchImpl })],
        imageProviders: [new GoogleNanoBananaImageProvider({ sql, fetchImpl: rec.fetchImpl })],
      });

      const provider = await router.routeExplicit("google_omni", specFor(a));
      assert.equal(provider.id, "google_omni", "workspace A has a usable key, so the provider is routable");

      await assert.rejects(
        router.routeExplicit("google_omni", specFor(b)),
        /NOT_CONFIGURED/,
        "workspace B has no usable key, so the provider is refused",
      );
      await assert.rejects(router.routeExplicit("google_omni", { ...specFor(a), organizationId: "" }), /NOT_CONFIGURED/, "no workspace is never routable");
      assert.equal(rec.calls(), 0, "routing itself sends no request");
    });
  });

  test(`[${name}] decision engine: JEV is READY for the workspace with a usable key, and never READY without a workspace`, async () => {
    const a = await studioTenant(sql, "engine-a");
    const b = await studioTenant(sql, "engine-b");
    await storeVaultCredential(sql, a.organizationId, CREDENTIAL_VAULT_TYPE.jev, { accessToken: "", apiKey: "engine-workspace-key-1111" });

    await withEnv({}, async () => {
      const rec = recorder(jevResponse);
      const router = new JevRouter({ typesafeProvider: new TypeSafeDirectJevProvider({ sql, fetchImpl: rec.fetchImpl }) });
      const engines = createDecisionEngines({ jevRouter: router });
      const jevHealth = async (organizationId: string | undefined) => {
        const status = await getDecisionEngineStatus(sql, organizationId, engines);
        return status.engines.find((engine) => engine.id === "jev")!.health.status;
      };
      assert.equal(await jevHealth(a.organizationId), "READY");
      assert.notEqual(await jevHealth(b.organizationId), "READY", "workspace B has no usable key");
      assert.notEqual(await jevHealth(undefined), "READY", "no workspace is never READY");
      assert.equal(rec.calls(), 0, "the status check sends no request");

      const engine = new JevDecisionEngine(router);
      assert.equal((await engine.health()).status, "NOT_CONFIGURED", "the engine's own health is never READY without a workspace");
      assert.equal((await engine.healthFor(a.organizationId)).status, "READY");
    });
  });
}
