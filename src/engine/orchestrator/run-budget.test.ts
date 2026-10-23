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

describe("a run's budget (run-budget.ts, D12: a budget is a line)", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, ORG);
  });

  after(async () => {
    await db.close();
  });

  test("a run whose spend has reached its line is not started: no reservation and no request row", async () => {
    const countRequests = async () =>
      Number(((await db.sql`select count(*) as n from engine_requests where organization_id = ${ORG} and format_id = 'orchestrator_run'`) as Array<{ n: string | number }>)[0]?.n);
    const requestsBefore = await countRequests();
    const opened = await openRunBudget(db.sql, {
      organizationId: ORG,
      planId: "plan_none_left",
      lineUsd: 1,
      spentUsd: 1,
      workspaceBudget: monthOf(100),
      now: () => NOW,
    });
    assert.equal(opened.status, "refused");
    if (opened.status === "refused") assert.match(opened.reasons[0] ?? "", /no paid step can run/);
    assert.equal(await countRequests(), requestsBefore, "no request row is written");
  });

  test("a run opens while its spend is below the line, and is refused once the spend reaches it: there is no tolerance", async () => {
    const inside = await openRunBudget(db.sql, { organizationId: ORG, planId: "plan_line_inside", lineUsd: 1, spentUsd: 0.99, workspaceBudget: monthOf(100), now: () => NOW });
    assert.equal(inside.status, "open", "$0.99 committed leaves $0.01 of the line, so the run may start");
    const atLine = await openRunBudget(db.sql, { organizationId: ORG, planId: "plan_line_at", lineUsd: 1, spentUsd: 1, workspaceBudget: monthOf(100), now: () => NOW });
    assert.equal(atLine.status, "refused", "a spend at the line has reached it: no tolerance past it");
  });

  test("a run is refused only when its workspace month is at its line, with the month's reason", async () => {
    const opened = await openRunBudget(db.sql, {
      organizationId: ORG,
      planId: "plan_month_full",
      lineUsd: 0.5,
      spentUsd: 0,
      workspaceBudget: monthOf(0),
      now: () => NOW,
    });
    assert.equal(opened.status, "refused");
    if (opened.status === "refused") assert.match(opened.reasons[0] ?? "", /^workspace monthly budget reached/);
  });

  test("a run takes one reservation for what its line leaves, with no allowance fields, and releasing it gives back what was not spent", async () => {
    const opened = await openRunBudget(db.sql, {
      organizationId: ORG,
      planId: "plan_open_release",
      lineUsd: 0.5,
      spentUsd: 0.1,
      workspaceBudget: monthOf(100),
      now: () => NOW,
    });
    assert.equal(opened.status, "open");
    if (opened.status !== "open") return;
    const before = await opened.budget.ledger.getReservation(opened.budget.reservationId);
    assert.equal(before?.reservedUsd, 0.4, "the reservation is what the line leaves");
    assert.equal(before?.requestBudgetUsd, 0.4, "the request budget is what the run may still spend");
    assert.equal(before?.mode, "cap");
    assert.equal(before && "requestAllowanceUsd" in before, false, "no request allowance is written (contract v11)");
    assert.equal(before && "workspaceMonthAllowanceUsd" in before, false, "no month allowance is written (contract v11)");

    await releaseRunBudget(db.sql, { organizationId: ORG, budget: opened.budget, requestStatus: "delivered" });
    const after = await opened.budget.ledger.getReservation(opened.budget.reservationId);
    assert.equal(after?.state, "released");
    assert.equal(after?.reservedUsd, 0, "nothing was spent, so the whole hold is given back");
    const rows = (await db.sql`select status from engine_requests where id = ${opened.budget.requestId}`) as Array<{ status: string }>;
    assert.equal(rows[0]?.status, "delivered");
  });

  test("a stored plan run with a budget releases its reservation when it stops, and ends delivered", async () => {
    await createPlanDraft(db.sql, { id: "plan_budget_run", organizationId: ORG, title: "budget run", brief: { goal: "A short branded video", format: "a hook, a product shot, a call to action", userInputs: "", brand: { name: "Example", summary: "plain" }, budgetUsd: examplePlan.budgetUsd }, orchestratorModel: "anthropic/claude-haiku-5.5", budgetUsd: examplePlan.budgetUsd });
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
