import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { getSql } from "../../db.ts";
import { createTenantFixture } from "../testing/production-fixtures.ts";
import { storeVaultCredential } from "../vault/service.ts";
import { CREDENTIAL_VAULT_TYPE } from "../credentials/contract.ts";
import { GeminiOmniVideoProvider } from "./providers/omni.ts";
import { pollProductionJobs } from "./poller.ts";
import type { CreativeSpec } from "./types.ts";

const KEY_A = "tenant-a-gemini-key-1111";
const KEY_B = "tenant-b-gemini-key-2222";
const DEPLOYMENT_KEY = "deployment-gemini-key-9999";

/**
 * The worker polls every organization's running jobs in one pass. Each request must carry the key of the organization
 * that owns the job, and a tenant with no key must not be polled with another tenant's key or with the deployment key.
 */
test("production poller: one pass polls each tenant's job with that tenant's own key, and a keyless tenant gets none", async () => {
  const previous = {
    TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY,
    MERIDIAN_GEMINI_API_KEY: process.env.MERIDIAN_GEMINI_API_KEY,
    PRODUCTION_SHARED_DEFAULT: process.env.PRODUCTION_SHARED_DEFAULT,
  };
  process.env.TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-poller-tenancy";
  process.env.MERIDIAN_GEMINI_API_KEY = DEPLOYMENT_KEY;
  delete process.env.PRODUCTION_SHARED_DEFAULT;

  try {
    const sql = await getSql();
    const tag = randomUUID().slice(0, 8);
    const tenantA = await createTenantFixture(sql, `keys-a-${tag}`, 50, "google_omni", "gemini-omni-1.1-flash");
    const tenantB = await createTenantFixture(sql, `keys-b-${tag}`, 50, "google_omni", "gemini-omni-1.1-flash");
    const tenantC = await createTenantFixture(sql, `keys-c-${tag}`, 50, "google_omni", "gemini-omni-1.1-flash");

    await storeVaultCredential(sql, tenantA.organizationId, CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: KEY_A, customFields: {} });
    await storeVaultCredential(sql, tenantB.organizationId, CREDENTIAL_VAULT_TYPE.production, { accessToken: "", apiKey: KEY_B, customFields: {} });

    const interactions = { a: `interactions/keys-a-${tag}`, b: `interactions/keys-b-${tag}`, c: `interactions/keys-c-${tag}` };
    const tenants = [
      { label: "a", tenant: tenantA, interaction: interactions.a },
      { label: "b", tenant: tenantB, interaction: interactions.b },
      { label: "c", tenant: tenantC, interaction: interactions.c },
    ];
    for (const { label, tenant, interaction } of tenants) {
      const spec: CreativeSpec = {
        id: `spec-keys-${label}-${tag}`,
        organizationId: tenant.organizationId,
        brandId: tenant.brandId,
        title: `Tenant ${label}`,
        modality: "video",
        format: "reel",
        aspectRatio: "9:16",
        durationTargetSeconds: 5,
        hookLine: "Hook",
        script: "Script",
        scenes: [],
      };
      const input = {
        creativeSpec: spec,
        runId: `run-keys-${label}-${tag}`,
        briefId: tenant.briefId,
        planDeliverableId: `deliverable-keys-${label}-${tag}`,
        manifest: { brand: { product: "Product" }, hook: { type: "problem", text: "Tired" }, concept: { mechanism: "demo" } },
      };
      await sql`
        insert into production_jobs (
          id, organization_id, brand_id, provider, provider_job_id, status, cost_mode, estimated_cost_cents,
          input, created_at, submitted_at, updated_at, creative_plan_id
        ) values (
          ${`prod-job-keys-${label}-${tag}`}, ${tenant.organizationId}, ${tenant.brandId}, 'google_omni', ${interaction}, 'RUNNING', 'BALANCED', 0,
          ${JSON.stringify(input)}, now(), now(), now(), ${tenant.plan.id}
        )
      `;
    }

    // Each status request is recorded with the interaction it asks about and the key it carries.
    const requests: Array<{ interaction: string; key: string | undefined }> = [];
    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const interaction = String(url).split("/").slice(-1)[0];
      const headers = (init?.headers as Record<string, string>) || {};
      requests.push({ interaction: `interactions/${interaction}`, key: headers["x-goog-api-key"] });
      return new Response(JSON.stringify({ interaction_id: `interactions/${interaction}`, status: "in_progress", steps: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const omni = new GeminiOmniVideoProvider({ fetchImpl: mockFetch });
    const router = { get: (id: string) => (id === "google_omni" ? omni : undefined) };
    await pollProductionJobs(sql, { router: router as any, driveClient: {} as any, limit: 50 });

    const keyFor = (interaction: string) => requests.filter((r) => r.interaction === interaction).map((r) => r.key);
    assert.deepEqual(keyFor(interactions.a), [KEY_A], "tenant A's job is polled with tenant A's key");
    assert.deepEqual(keyFor(interactions.b), [KEY_B], "tenant B's job is polled with tenant B's key");
    assert.deepEqual(keyFor(interactions.c), [], "tenant C has no key, so its job is not polled with anyone else's key");
    assert.equal(requests.some((r) => r.key === DEPLOYMENT_KEY), false, "the deployment key is not used without the operator's opt-in");
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
