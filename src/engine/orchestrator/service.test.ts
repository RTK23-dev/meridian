import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { fixture, gatewayFor, json } from "../claude/test/helpers.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { loadCatalog, type CatalogEntry } from "./catalog.ts";
import type { WorkspaceBudgetSource, WorkspaceMonthBudget } from "../jobs/handlers/estimate-reserve.ts";
import { planInputTokensOf, planStoredDraft, type PlanScope } from "./service.ts";
import { createPlanDraft, getPlan } from "./store.ts";
import { estimateFromPriceUsd } from "../claude/rates.ts";

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

/** A workspace month source with a fixed answer: a known budget, or not connected. It reads nothing. */
function monthOf(answer: WorkspaceMonthBudget): WorkspaceBudgetSource {
  return { monthBudget: async () => answer };
}

function scopeFor(db: TestDatabase, responses: Parameters<typeof gatewayFor>[0], ids: { request: string; reservation: string }, catalogOverride?: Map<string, CatalogEntry>): PlanScope {
  return {
    sql: db.sql,
    organizationId: ORG,
    gateway: gatewayFor(responses).gateway,
    catalog: catalogOverride ?? catalog,
    catalogReadAt: recorded.takenAt,
    now: () => NOW,
    mint: { request: () => ids.request, reservation: () => ids.reservation },
    workspaceBudget: monthOf({ status: "known", usd: 100 }),
  };
}

async function holdCount(db: TestDatabase, reservationId: string): Promise<number> {
  const rows = (await db.sql`select count(*) as n from engine_reservations where id = ${reservationId}`) as Array<{ n: string | number }>;
  return Number(rows[0]?.n ?? 0);
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

  test("a planning call whose hold does not fit the budget is refused before any call, and no hold is written (D17)", async () => {
    await draft(db, "plan_svc_budget", 0.0001);
    const ids = { request: "req_01JABCDEFGHJKMNPQRSTVWXYZ4", reservation: "res_01JABCDEFGHJKMNPQRSTVWXYZ4" };
    const outcome = await planStoredDraft(scopeFor(db, [json(200, fixture("openrouter-orchestrator-plan-ok"))], ids), "plan_svc_budget");
    assert.equal(outcome.status, "refused");
    if (outcome.status === "refused") {
      assert.match(outcome.reasons[0] ?? "", /^the plan call's hold of \$[0-9.]+ would take the spend past the \$0\.0001 budget \(committed \$0\.0000\), so the draft is refused before any call$/);
    }
    assert.equal(await roleCallsFor(db, ids.request), 0, "no call is made");
    assert.equal(await holdCount(db, ids.reservation), 0, "no reservation is written");
    assert.equal((await getPlan(db.sql, ORG, "plan_svc_budget"))?.status, "refused");
  });

  test("a plan that is already ready is not planned again, and another organization gets not found", async () => {
    const ids = { request: "req_01JABCDEFGHJKMNPQRSTVWXYZ5", reservation: "res_01JABCDEFGHJKMNPQRSTVWXYZ5" };
    const again = await planStoredDraft(scopeFor(db, [], ids), "plan_svc_ready");
    assert.equal(again.status, "not_planned");
    const elsewhere = await planStoredDraft({ ...scopeFor(db, [], ids), organizationId: OTHER }, "plan_svc_ready");
    assert.deepEqual(elsewhere, { status: "not_found" });
  });

  test("a plan call that would take the workspace month over its budget is refused, and no hold is written", async () => {
    await draft(db, "plan_svc_month");
    const ids = { request: "req_01JABCDEFGHJKMNPQRSTVWXYZ6", reservation: "res_01JABCDEFGHJKMNPQRSTVWXYZ6" };
    // A month with a zero budget is at its line before the call, whatever this month has committed (earlier tests write calls to it).
    const scope = { ...scopeFor(db, [], ids), workspaceBudget: monthOf({ status: "known", usd: 0 }) };
    const outcome = await planStoredDraft(scope, "plan_svc_month");
    assert.equal(outcome.status, "refused");
    if (outcome.status === "refused") assert.match(outcome.reasons[0] ?? "", /^workspace monthly budget reached: \$[0-9.]+ is committed against the \$0\.0000 budget/);
    assert.equal((await getPlan(db.sql, ORG, "plan_svc_month"))?.status, "refused");
    assert.equal(await roleCallsFor(db, ids.request), 0, "no call is made");
    assert.equal(await holdCount(db, ids.reservation), 0, "no reservation is written");
  });

  test("a workspace month that is not known refuses the call before any hold, with the source's reason", async () => {
    await draft(db, "plan_svc_nomonth");
    const ids = { request: "req_01JABCDEFGHJKMNPQRSTVWXYZ7", reservation: "res_01JABCDEFGHJKMNPQRSTVWXYZ7" };
    const reason = "no monthly video budget is set for this workspace; set \"Monthly video budget (USD)\" in Settings";
    const scope = { ...scopeFor(db, [], ids), workspaceBudget: monthOf({ status: "not_connected", reason }) };
    const outcome = await planStoredDraft(scope, "plan_svc_nomonth");
    assert.equal(outcome.status, "refused");
    if (outcome.status === "refused") assert.deepEqual(outcome.reasons, [reason]);
    assert.equal(await roleCallsFor(db, ids.request), 0);
    assert.equal(await holdCount(db, ids.reservation), 0);
  });

  test("a plan whose budget is above the budget the user set is stored as ready, with a note: the run stops at the user's budget", async () => {
    await draft(db, "plan_svc_overbudget", 1);
    const ids = { request: "req_01JABCDEFGHJKMNPQRSTVWXYZ8", reservation: "res_01JABCDEFGHJKMNPQRSTVWXYZ8" };
    const outcome = await planStoredDraft(scopeFor(db, [json(200, fixture("openrouter-orchestrator-plan-ok"))], ids), "plan_svc_overbudget");
    assert.equal(outcome.status, "ready", "a plan that asks for more is a plan, not a refusal (envelope.ts)");
    const stored = await getPlan(db.sql, ORG, "plan_svc_overbudget");
    assert.equal(stored?.plan?.budgetUsd, 2, "the plan keeps the budget it asked for");
    assert.equal(stored?.budgetUsd, 1, "the user's budget is unchanged");
    assert.ok(stored?.reasons.includes("the plan asks for $2.0000; the run stops at the $1.0000 budget you set"), `the note is stored: ${stored?.reasons.join(" | ")}`);
  });

  test("a model whose hold would have more than four decimals never leaves the plan in planning", async () => {
    await draft(db, "plan_svc_cheap");
    const ids = { request: "req_01JABCDEFGHJKMNPQRSTVWXYZ9", reservation: "res_01JABCDEFGHJKMNPQRSTVWXYZ9" };
    const entry = catalog.get(HAIKU);
    if (entry === undefined) throw new Error("haiku must be in the recorded catalog");
    const cheap = new Map(catalog);
    cheap.set(HAIKU, { ...entry, pricing: { ...entry.pricing, promptUsdPerToken: 0.000000123 } });
    await planStoredDraft(scopeFor(db, [json(200, fixture("openrouter-orchestrator-plan-ok"))], ids, cheap), "plan_svc_cheap");
    const stored = await getPlan(db.sql, ORG, "plan_svc_cheap");
    assert.ok(stored?.status === "ready" || stored?.status === "refused", `the plan is ${stored?.status}, not planning`);
    assert.equal(await holdCount(db, ids.reservation), 1, "the hold is written, with a valid reservation shape");
  });

  test("the planning call is held for the count its check sized: the reviewer's fixture is 54,062 input tokens, and the check and the hold are that same amount", async () => {
    // The reviewer's fixture: this brief and this catalog size the call at 54,062 input tokens (the role's own estimate is 8,000).
    const fixtureBrief = {
      goal: "A short branded video",
      format: "a hook, a product shot, a call to action",
      userInputs: "",
      brand: { name: "Example", summary: "plain" },
      budgetUsd: 1,
    };
    assert.equal(planInputTokensOf(catalog, fixtureBrief), 54062, "the check sizes the fixture's call at 54,062 input tokens");
    await createPlanDraft(db.sql, { id: "plan_svc_sized", organizationId: ORG, title: "sized", brief: fixtureBrief, orchestratorModel: HAIKU, budgetUsd: 1 });
    const ids = { request: "req_01JABCDEFGHJKMNPQRSTVWXYZA", reservation: "res_01JABCDEFGHJKMNPQRSTVWXYZA" };
    const outcome = await planStoredDraft(scopeFor(db, [json(200, fixture("openrouter-orchestrator-plan-ok"))], ids), "plan_svc_sized");
    assert.equal(outcome.status, "ready", "the sized call is held within the user's budget, so it is made");

    const entry = catalog.get(HAIKU);
    if (entry === undefined) throw new Error("haiku must be in the recorded catalog");
    const { promptUsdPerToken, completionUsdPerToken } = entry.pricing;
    if (promptUsdPerToken === null || completionUsdPerToken === null) throw new Error("haiku must have a per-token price");
    const sizedUsd = estimateFromPriceUsd({ promptUsdPerToken, completionUsdPerToken }, { input: 54062, output: 4000 });
    const roleOnlyUsd = estimateFromPriceUsd({ promptUsdPerToken, completionUsdPerToken }, { input: 8000, output: 4000 });
    assert.ok(sizedUsd > roleOnlyUsd, "the sized call costs more than the role's fixed estimate, so holding the role's would undercount it");

    // The check's estimate (the reservation) and the call's hold (its ledger entry) are the same sized amount.
    const reservations = (await db.sql`select estimate_usd from engine_reservations where id = ${ids.reservation}`) as Array<{ estimate_usd: unknown }>;
    assert.equal(Number(reservations[0]?.estimate_usd), sizedUsd, "the check sizes the hold from 54,062 input tokens");
    const ledger = (await db.sql`select estimate_usd from engine_ledger where reservation_id = ${ids.reservation}`) as Array<{ estimate_usd: unknown }>;
    assert.deepEqual(ledger.map((row) => Number(row.estimate_usd)), [sizedUsd], "the call is held at the check's amount, not at the role's 8,000-token estimate");
  });
});
