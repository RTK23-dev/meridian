import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { loadCatalog } from "./catalog.ts";
import { examplePlan } from "./example.ts";
import type { Handlers } from "./execute.ts";
import { openRunBudget, releaseRunBudget } from "./run-budget.ts";
import { runStoredPlan } from "./run.ts";
import { createPlanDraft, recordPlanOutcome } from "./store.ts";
import { NODE_KINDS } from "./contracts.ts";
import type { WorkspaceBudgetSource } from "../jobs/handlers/estimate-reserve.ts";

const ORG = "org_run_budget_a";
const NOW = "2026-10-22T10:00:00.000Z";
const catalog = loadCatalog(JSON.parse(readFileSync(new URL("./fixtures/openrouter-catalog-2026-10-20.json", import.meta.url), "utf8"))).byId;

function monthOf(usd: number): WorkspaceBudgetSource {
  return {
    async monthBudget() {
      return { status: "known", usd } as Awaited<ReturnType<WorkspaceBudgetSource["monthBudget"]>>;
    },
  };
}

describe("a run's budget (run-budget.ts)", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, ORG);
  });

  after(async () => {
    await db.close();
  });

  test("a plan with nothing left to spend is not started: no reservation and no request row", async () => {
    const opened = await openRunBudget(db.sql, {
      organizationId: ORG,
      planId: "plan_none_left",
      planBudgetUsd: 1,
      requestBudgetUsd: 1,
      spentUsd: 1,
      workspaceBudget: monthOf(100),
      now: () => NOW,
    });
    assert.equal(opened.status, "refused");
    if (opened.status === "refused") assert.match(opened.reasons[0] ?? "", /no paid step can run/);
  });

  test("a run that would take the workspace month past its budget is refused before it starts", async () => {
    const opened = await openRunBudget(db.sql, {
      organizationId: ORG,
      planId: "plan_month_full",
      planBudgetUsd: 0.5,
      requestBudgetUsd: 0.5,
      spentUsd: 0,
      workspaceBudget: monthOf(0.1),
      now: () => NOW,
    });
    assert.equal(opened.status, "refused");
    if (opened.status === "refused") assert.match(opened.reasons[0] ?? "", /monthly budget/);
  });

  test("a run takes one reservation for what the plan may still spend, and releasing it gives back what was not spent", async () => {
    const opened = await openRunBudget(db.sql, {
      organizationId: ORG,
      planId: "plan_open_release",
      planBudgetUsd: 0.5,
      requestBudgetUsd: 1,
      spentUsd: 0.1,
      workspaceBudget: monthOf(100),
      now: () => NOW,
    });
    assert.equal(opened.status, "open");
    if (opened.status !== "open") return;
    const before = await opened.budget.ledger.getReservation(opened.budget.reservationId);
    assert.equal(before?.reservedUsd, 0.4, "the reservation is what the plan has not yet spent");

    await releaseRunBudget(db.sql, { organizationId: ORG, budget: opened.budget, requestStatus: "delivered" });
    const after = await opened.budget.ledger.getReservation(opened.budget.reservationId);
    assert.equal(after?.state, "released");
    assert.equal(after?.reservedUsd, 0, "nothing was spent, so the whole hold is given back");
    const rows = (await db.sql`select status from engine_requests where id = ${opened.budget.requestId}`) as Array<{ status: string }>;
    assert.equal(rows[0]?.status, "delivered");
  });

  test("a stored plan run with a budget releases its reservation when it stops, and ends delivered", async () => {
    await createPlanDraft(db.sql, { id: "plan_budget_run", organizationId: ORG, title: "budget run", brief: { goal: "g" }, orchestratorModel: "anthropic/claude-haiku-5.5", budgetUsd: examplePlan.budgetUsd });
    await recordPlanOutcome(db.sql, { id: "plan_budget_run", organizationId: ORG, plan: examplePlan, reasons: [], catalogReadAt: null });

    // Stand-in handlers for every kind: no provider and no ledger write, so the run takes its reservation and gives it back in full.
    const handlers: Handlers = {};
    for (const kind of NODE_KINDS) handlers[kind] = async ({ node }) => ({ outputHash: `h_${node.id}`, costUsd: null, body: null });
    const outcome = await runStoredPlan(db.sql, {
      organizationId: ORG,
      planId: "plan_budget_run",
      catalog,
      budget: { workspaceBudget: monthOf(100), now: () => NOW, handlersFor: () => handlers },
    });
    assert.equal(outcome.status, "complete");
    const rows = (await db.sql`
      select status from engine_requests where organization_id = ${ORG} and format_id = 'orchestrator_run' and state::text like ${"%plan_budget_run%"}
    `) as Array<{ status: string }>;
    assert.deepEqual(rows.map((row) => row.status), ["delivered"]);
  });
});
