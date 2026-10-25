// One decision, followed from its origin to the creative it produced, on the database the tests run on (PGlite here, Postgres when
// MERIDIAN_PG_TEST_URL is set). The chain is: an opportunity and the decision that scored it, then the brief the studio writes from the
// opportunity with a second decision from the JEV engine, then the creative generated from that brief. Each link is read back from the
// stored rows, and each boundary checks the organization and brand. The OpenAI decisions stub must receive no request: no fallback backend
// is consulted. The decision engines and the text model are fixtures; no test calls a live provider.
//
// This proof does not cover the human review of the creative. The reviewed-creative step is a separate closeout item.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { approvesBriefCalibrated, registryWith, stubEngine } from "../testing/brief-fixtures.ts";
import { seedBrandBrain, seedOpportunity } from "../testing/opportunity-fixtures.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { setMonthlyBudget } from "../testing/monthly-budget.ts";
import { enableAppAliases } from "../testing/module-aliases.ts";

// The studio server functions use the "@/" alias, so the alias hook is registered before they are loaded.
enableAppAliases();
const { createBriefFromOpportunityFor } = await import("./opportunity-brief.server.ts");
const { generateCreativeFor } = await import("./creative-generation.server.ts");

const COPY = { hook: "Dinner in ten minutes", script: "A calm dinner plan that needs no planning.", offer: "", cta: "See it in use", visualTreatment: "Kitchen counter", claims: [] };
const RECORDED_LISTINGS = JSON.parse(readFileSync(new URL("../../../engine/orchestrator/fixtures/openrouter-listings-trimmed-2026-10-20.json", import.meta.url), "utf8")).listings as Record<string, unknown>;
const TEXT_MODEL = "anthropic/claude-haiku-5.5";

/** The text model is answered by a fixture over fetch. Chat completions are counted; the environment and fetch are restored afterwards. */
async function withTextModel<T>(run: (calls: { count: number }) => Promise<T>): Promise<T> {
  const saved = { fetch: globalThis.fetch, key: process.env.OPENROUTER_API_KEY, model: process.env.OPENROUTER_MODEL, shared: process.env.OPENROUTER_SHARED_DEFAULT };
  const calls = { count: 0 };
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_MODEL = TEXT_MODEL;
  process.env.OPENROUTER_SHARED_DEFAULT = "deployment";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/chat/completions")) {
      calls.count += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(COPY) } }], usage: { total_tokens: 12 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const listing = RECORDED_LISTINGS[url.replace("https://openrouter.ai/api/v1", "")];
    return new Response(JSON.stringify(listing ?? { data: [] }), { status: listing === undefined ? 404 : 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved.key;
    if (saved.model === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = saved.model;
    if (saved.shared === undefined) delete process.env.OPENROUTER_SHARED_DEFAULT;
    else process.env.OPENROUTER_SHARED_DEFAULT = saved.shared;
  }
}

/** The decision row a stored id names, read back. Null when no row has that id. */
async function decisionRow(sql: Sql, id: string) {
  const [row] = await sql<{ organization_id: string; brand_id: string; decision: string; subject_type: string; subject_id: string }>`
    select organization_id, brand_id, decision, subject_type, subject_id from jev_decisions where id = ${id}
  `;
  return row ?? null;
}

test("one decision is followed from its opportunity through the brief to the creative, with the tenant checked at each link", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "lineage-chain");
  // A second tenant, used to show that the chain is not readable from another workspace.
  const other = await studioTenant(sql, "lineage-other");
  await seedBrandBrain(sql, tenant);
  // Paid generation is blocked without a monthly budget, so this workspace has one.
  await setMonthlyBudget(sql, tenant.organizationId, 1);

  // Origin: the opportunity, and the decision that scored it, both in this workspace.
  const origin = await seedOpportunity(sql, tenant, { outcome: "AUTO_APPROVE" });
  const originDecision = await decisionRow(sql, origin.decisionId);
  assert.ok(originDecision, "the opportunity's decision is stored");
  assert.equal(originDecision.organization_id, tenant.organizationId, "the origin decision belongs to the workspace");
  assert.equal(originDecision.brand_id, tenant.brandId, "the origin decision belongs to the brand");
  assert.equal(originDecision.subject_type, "opportunity");
  assert.equal(originDecision.subject_id, origin.opportunityId, "the origin decision names its opportunity");
  const [opportunity] = await sql<{ decision_id: string }>`select decision_id from opportunities where id = ${origin.opportunityId}`;
  assert.equal(opportunity?.decision_id, origin.decisionId, "the opportunity points at the decision that scored it");

  // Studio: the brief written from the opportunity. The JEV engine judges it; the OpenAI engine is the fallback that must not run.
  const jev = stubEngine("jev", { respond: approvesBriefCalibrated });
  const fallback = stubEngine("openai-decisions");
  const made = await createBriefFromOpportunityFor(
    tenant.userId,
    { brandId: tenant.brandId, opportunityId: origin.opportunityId },
    { engines: registryWith(jev, fallback), selection: { engineId: "jev", source: "workspace" } },
  );
  assert.equal(made.decision, "AUTO_APPROVE");
  assert.ok(jev.requests.length > 0, "the chosen engine judged the brief");
  assert.equal(fallback.requests.length, 0, "no fallback backend is consulted");

  const [brief] = await sql<{ opportunity_id: string; decision_id: string; organization_id: string; brand_id: string }>`
    select opportunity_id, decision_id, organization_id, brand_id from briefs where id = ${made.id}
  `;
  assert.equal(brief?.opportunity_id, origin.opportunityId, "the brief names the opportunity it came from");
  assert.equal(brief?.organization_id, tenant.organizationId);
  assert.equal(brief?.brand_id, tenant.brandId);
  const briefDecision = await decisionRow(sql, brief?.decision_id ?? "");
  assert.ok(briefDecision, "the brief's decision is stored");
  assert.equal(briefDecision.organization_id, tenant.organizationId, "the brief decision belongs to the workspace");
  assert.equal(briefDecision.brand_id, tenant.brandId, "the brief decision belongs to the brand");
  assert.equal(briefDecision.subject_id, made.id, "the brief decision names the brief");
  assert.equal(briefDecision.decision, "AUTO_APPROVE");

  // Creative: generated from the brief. The run is recorded against the brief, in the same workspace.
  await withTextModel(async (calls) => {
    const result = await generateCreativeFor(tenant.userId, { brandId: tenant.brandId, briefId: made.id });
    assert.equal(result.status, "completed");
    assert.equal(calls.count, 1, "the text model is called once for the brief");
  });
  const runs = await sql<{ organization_id: string; brand_id: string; input_ref: string; status: string }>`
    select organization_id, brand_id, input_ref, status from model_runs where input_ref = ${made.id} and status = 'completed'
  `;
  assert.equal(runs.length, 1, "one completed creative run is recorded against the brief");
  assert.equal(runs[0]?.organization_id, tenant.organizationId, "the creative run belongs to the workspace");
  assert.equal(runs[0]?.brand_id, tenant.brandId, "the creative run belongs to the brand");

  // Scope: another workspace cannot read the chain. Its generation of this brief is refused, and nothing is recorded for it.
  await withTextModel(async (calls) => {
    await assert.rejects(generateCreativeFor(other.userId, { brandId: tenant.brandId, briefId: made.id }));
    assert.equal(calls.count, 0, "no text model is called for another workspace");
  });
  const [crossRows] = await sql<{ count: number }>`
    select count(*)::int as count from jev_decisions where id = ${origin.decisionId} and organization_id = ${other.organizationId}
  `;
  assert.equal(crossRows?.count, 0, "the origin decision is not visible to another workspace");
});
