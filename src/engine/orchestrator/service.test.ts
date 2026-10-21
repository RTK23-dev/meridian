import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { fixture, gatewayFor, json } from "../claude/test/helpers.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { loadCatalog, type CatalogEntry } from "./catalog.ts";
import { planStoredDraft, type PlanScope } from "./service.ts";
import { createPlanDraft, getPlan } from "./store.ts";

const ORG = "org_svc_a";
const OTHER = "org_svc_b";
const NOW = "2026-10-21T10:00:00.000Z";
const HAIKU = "anthropic/claude-haiku-5.5";
const BRIEF = {
  goal: "A 15 second product video",
  format: "a hook, a product shot, a call to action",
  userInputs: "the product is a water bottle",
  brand: { name: "Example", summary: "calm, blue, plain type" },
  budgetUsd: 2,
};
const recorded = loadCatalog(JSON.parse(readFileSync(new URL("./fixtures/openrouter-catalog-2026-10-20.json", import.meta.url), "utf8")));
const catalog = recorded.byId;

function scopeFor(db: TestDatabase, responses: Parameters<typeof gatewayFor>[0], ids: { request: string; reservation: string }, catalogOverride?: Map<string, CatalogEntry>): PlanScope {
  return {
    sql: db.sql,
    organizationId: ORG,
    gateway: gatewayFor(responses).gateway,
    catalog: catalogOverride ?? catalog,
    catalogReadAt: recorded.takenAt,
    now: () => NOW,
    mint: { request: () => ids.request, reservation: () => ids.reservation },
  };
}

async function draft(db: TestDatabase, id: string, budgetUsd = 2, model = HAIKU): Promise<void> {
  await createPlanDraft(db.sql, { id, organizationId: ORG, title: id, brief: { ...BRIEF, budgetUsd }, orchestratorModel: model, budgetUsd });
}

async function roleCallsFor(db: TestDatabase, requestId: string): Promise<number> {
  const rows = (await db.sql`select count(*) as n from engine_role_calls where request_id = ${requestId} and role = 'orchestrator_plan'`) as Array<{ n: string | number }>;
  return Number(rows[0]?.n ?? 0);
}

describe("planStoredDraft: the chosen model plans a stored draft, on a hold, through the client", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, ORG);
    await seedWorkspace(db.sql, OTHER);
  });

  after(async () => {
    await db.close();
  });

  test("a draft becomes a ready plan: one journaled call, its hold on the ledger, and the checked plan stored", async () => {
    await draft(db, "plan_svc_ready");
    const ids = { request: "req_01JABCDEFGHJKMNPQRSTVWXYZ1", reservation: "res_01JABCDEFGHJKMNPQRSTVWXYZ1" };
    const outcome = await planStoredDraft(scopeFor(db, [json(200, fixture("openrouter-orchestrator-plan-ok"))], ids), "plan_svc_ready");
    assert.equal(outcome.status, "ready");
    const stored = await getPlan(db.sql, ORG, "plan_svc_ready");
    assert.equal(stored?.status, "ready");
    assert.equal(stored?.plan?.orchestrator.id, HAIKU);
    assert.equal(await roleCallsFor(db, ids.request), 1, "the call is on the journal");
    const holds = (await db.sql`select count(*) as n from engine_reservations where id = ${ids.reservation}`) as Array<{ n: string | number }>;
    assert.equal(Number(holds[0]?.n ?? 0), 1, "the call is held on the ledger before it is made");
  });

  test("a plan that names another model is refused after the retry, with the reason, and nothing is stored as a plan", async () => {
    await draft(db, "plan_svc_refused");
    const ids = { request: "req_01JABCDEFGHJKMNPQRSTVWXYZ2", reservation: "res_01JABCDEFGHJKMNPQRSTVWXYZ2" };
    const other = fixture("openrouter-orchestrator-plan-other-model");
    const outcome = await planStoredDraft(scopeFor(db, [json(200, other), json(200, other)], ids), "plan_svc_refused");
    assert.equal(outcome.status, "refused");
    if (outcome.status === "refused") assert.match(outcome.reasons[0] ?? "", /did not match the plan contract/);
    assert.equal((await getPlan(db.sql, ORG, "plan_svc_refused"))?.plan, null);
    assert.equal(await roleCallsFor(db, ids.request), 2, "the call and its retry are both journaled");
  });

  test("a model with no live price is refused before any hold is taken or call is made", async () => {
    await draft(db, "plan_svc_unpriced");
    const ids = { request: "req_01JABCDEFGHJKMNPQRSTVWXYZ3", reservation: "res_01JABCDEFGHJKMNPQRSTVWXYZ3" };
    const entry = catalog.get(HAIKU);
    if (entry === undefined) throw new Error("haiku must be in the recorded catalog");
    const unpriced = new Map(catalog);
    unpriced.set(HAIKU, { ...entry, pricing: { ...entry.pricing, promptUsdPerToken: null } });
    const outcome = await planStoredDraft(scopeFor(db, [], ids, unpriced), "plan_svc_unpriced");
    assert.equal(outcome.status, "refused");
    if (outcome.status === "refused") assert.match(outcome.reasons[0] ?? "", /has no per-token price in the listing/);
    assert.equal(await roleCallsFor(db, ids.request), 0);
    const holds = (await db.sql`select count(*) as n from engine_reservations where id = ${ids.reservation}`) as Array<{ n: string | number }>;
    assert.equal(Number(holds[0]?.n ?? 0), 0);
  });

  test("a call whose estimate is over the plan's budget is refused before the hold", async () => {
    await draft(db, "plan_svc_budget", 0.0001);
    const ids = { request: "req_01JABCDEFGHJKMNPQRSTVWXYZ4", reservation: "res_01JABCDEFGHJKMNPQRSTVWXYZ4" };
    const outcome = await planStoredDraft(scopeFor(db, [], ids), "plan_svc_budget");
    assert.equal(outcome.status, "refused");
    if (outcome.status === "refused") assert.match(outcome.reasons[0] ?? "", /over the plan's \$0\.0001 budget, so no call is made/);
  });

  test("a plan that is already ready is not planned again, and another organization gets not found", async () => {
    const ids = { request: "req_01JABCDEFGHJKMNPQRSTVWXYZ5", reservation: "res_01JABCDEFGHJKMNPQRSTVWXYZ5" };
    const again = await planStoredDraft(scopeFor(db, [], ids), "plan_svc_ready");
    assert.equal(again.status, "not_planned");
    const elsewhere = await planStoredDraft({ ...scopeFor(db, [], ids), organizationId: OTHER }, "plan_svc_ready");
    assert.deepEqual(elsewhere, { status: "not_found" });
  });
});
