import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { contentHash } from "../contracts/hash.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { approvePlanBudget, listBudgetApprovals } from "./approval.ts";
import { loadCatalog } from "./catalog.ts";
import { NODE_KINDS, orchestratorPlanSchema, type OrchestratorPlan } from "./contracts.ts";
import type { Handlers, NodeHandler } from "./execute.ts";
import { runStoredPlan } from "./run.ts";
import { createPlanDraft, getPlan, listPlanEvents, recordPlanOutcome } from "./store.ts";

const ORG = "org_approval_a";
const OTHER = "org_approval_b";
const catalog = loadCatalog(JSON.parse(readFileSync(new URL("./fixtures/openrouter-catalog-2026-10-20.json", import.meta.url), "utf8"))).byId;
const sample: OrchestratorPlan = orchestratorPlanSchema.parse(JSON.parse(readFileSync(new URL("./fixtures/sample-plan.json", import.meta.url), "utf8")));

/** Stand-in handlers for every kind. A step is charged its estimate, since no cost is reported. */
function standIn(): Handlers {
  const handlers: Record<string, NodeHandler> = {};
  for (const kind of NODE_KINDS) {
    handlers[kind] = async ({ node }) => ({ outputHash: contentHash({ id: node.id, kind: node.kind }), costUsd: null });
  }
  return handlers as Handlers;
}

describe("approving a paused plan's budget (owner direction 2026-10-23)", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, ORG);
    await seedWorkspace(db.sql, OTHER);
  });

  after(async () => {
    await db.close();
  });

  /** A stored, ready plan whose budget the user set. The plan's own budget is the sample's, which is larger. */
  async function storedPlan(id: string, budgetUsd: number): Promise<void> {
    const brief = {
      goal: "A short branded video",
      format: "a hook, a product shot, a call to action",
      userInputs: "",
      brand: { name: "Example", summary: "plain" },
      budgetUsd,
    };
    await createPlanDraft(db.sql, { id, organizationId: ORG, title: id, brief, orchestratorModel: "vendor-a/model-x", budgetUsd });
    await recordPlanOutcome(db.sql, { id, organizationId: ORG, plan: sample, reasons: [], catalogReadAt: null });
  }

  test("an approval raises a paused plan's budget, and the run then continues past the old line", async () => {
    // The line is $0.20: the analysis, the script, the still and the voice start below it ($0.23 committed), and the video does not start.
    await storedPlan("plan_approval_resume", 0.2);
    const paused = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_approval_resume", catalog, handlers: standIn() });
    assert.equal(paused.status, "paused", "a plan whose spend reaches the user's budget pauses before the next paid step");

    const approved = await approvePlanBudget(db.sql, { organizationId: ORG, planId: "plan_approval_resume", budgetUsd: 2, actorId: "user_admin_a" });
    assert.deepEqual(approved, { status: "approved", previousUsd: 0.2, budgetUsd: 2 });
    const stored = await getPlan(db.sql, ORG, "plan_approval_resume");
    assert.equal(stored?.budgetUsd, 2, "the set budget is the approved amount");
    assert.equal(stored?.plan?.budgetUsd, 2, "the plan's own budget is raised too, so the run's target is the approved amount");

    const resumed = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_approval_resume", catalog, handlers: standIn() });
    assert.equal(resumed.status, "complete");
  });

  test("an approval is refused unless the plan is paused, and the amount must be above the budget the plan has now", async () => {
    await storedPlan("plan_approval_ready", 0.2);
    const ready = await approvePlanBudget(db.sql, { organizationId: ORG, planId: "plan_approval_ready", budgetUsd: 2, actorId: "user_admin_a" });
    assert.equal(ready.status, "refused");
    assert.match(ready.status === "refused" ? ready.reasons.join(" ") : "", /only a plan paused for an approval/);

    await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_approval_ready", catalog, handlers: standIn() });
    const notAbove = await approvePlanBudget(db.sql, { organizationId: ORG, planId: "plan_approval_ready", budgetUsd: 0.2, actorId: "user_admin_a" });
    assert.equal(notAbove.status, "refused");
    assert.match(notAbove.status === "refused" ? notAbove.reasons.join(" ") : "", /must be above the \$0\.2000/);
    assert.equal((await getPlan(db.sql, ORG, "plan_approval_ready"))?.status, "paused", "a refused approval changes nothing");
  });

  test("another organization cannot approve a plan: the approval reads as not found", async () => {
    await storedPlan("plan_approval_scoped", 0.5);
    await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_approval_scoped", catalog, handlers: standIn() });
    const outcome = await approvePlanBudget(db.sql, { organizationId: OTHER, planId: "plan_approval_scoped", budgetUsd: 2, actorId: "user_other" });
    assert.equal(outcome.status, "not_found");
    assert.equal((await getPlan(db.sql, ORG, "plan_approval_scoped"))?.budgetUsd, 0.5);
  });

  test("an approval writes exactly one audit row: the actor, the budget it replaced, the budget it set, and the pause reason", async () => {
    await storedPlan("plan_approval_audit", 0.5);
    await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_approval_audit", catalog, handlers: standIn() });
    const pauses = (await listPlanEvents(db.sql, ORG, "plan_approval_audit", 0)).filter((event) => event.state === "paused");
    const pauseReason = pauses[pauses.length - 1]?.reason ?? null;
    assert.ok(pauseReason !== null && pauseReason.length > 0, "the run stored a pause reason for the approval to record");

    const approved = await approvePlanBudget(db.sql, { organizationId: ORG, planId: "plan_approval_audit", budgetUsd: 2, actorId: "user_admin_a" });
    assert.equal(approved.status, "approved");
    const rows = await listBudgetApprovals(db.sql, ORG, "plan_approval_audit", 10);
    assert.equal(rows.length, 1, "one approval, one audit row");
    assert.equal(rows[0]?.actorId, "user_admin_a");
    assert.equal(rows[0]?.previousUsd, 0.5);
    assert.equal(rows[0]?.approvedUsd, 2);
    assert.equal(rows[0]?.reason, pauseReason, "the reason is the pause reason the plan showed at the time");
  });

  test("a refused approval writes no audit row", async () => {
    await storedPlan("plan_approval_norow", 0.5);
    const notPaused = await approvePlanBudget(db.sql, { organizationId: ORG, planId: "plan_approval_norow", budgetUsd: 2, actorId: "user_admin_a" });
    assert.equal(notPaused.status, "refused");

    await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_approval_norow", catalog, handlers: standIn() });
    const notAbove = await approvePlanBudget(db.sql, { organizationId: ORG, planId: "plan_approval_norow", budgetUsd: 0.5, actorId: "user_admin_a" });
    assert.equal(notAbove.status, "refused");
    assert.deepEqual(await listBudgetApprovals(db.sql, ORG, "plan_approval_norow", 10), [], "no refused approval is recorded");
  });

  test("a failing audit insert leaves the plan unchanged: the plan update and its record are one statement", async () => {
    await storedPlan("plan_approval_auditfail", 0.5);
    await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_approval_auditfail", catalog, handlers: standIn() });
    const planBefore = await getPlan(db.sql, ORG, "plan_approval_auditfail");
    await db.exec(
      "create function refuse_budget_audit() returns trigger language plpgsql as $$ begin raise exception 'the audit row was refused'; end $$;" +
        " create trigger refuse_budget_audit before insert on orchestrator_budget_approvals for each row execute function refuse_budget_audit();",
    );
    try {
      await assert.rejects(
        approvePlanBudget(db.sql, { organizationId: ORG, planId: "plan_approval_auditfail", budgetUsd: 2, actorId: "user_admin_a" }),
        /the audit row was refused/,
      );
    } finally {
      await db.exec("drop trigger if exists refuse_budget_audit on orchestrator_budget_approvals; drop function if exists refuse_budget_audit();");
    }
    assert.deepEqual(await getPlan(db.sql, ORG, "plan_approval_auditfail"), planBefore, "the plan is exactly as it was before the approval");
    assert.deepEqual(await listBudgetApprovals(db.sql, ORG, "plan_approval_auditfail", 10), []);
  });

  test("a plan's approvals are listed newest first, the limit applies, and another organization lists none", async () => {
    await storedPlan("plan_approval_list", 0.5);
    await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_approval_list", catalog, handlers: standIn() });
    const first = await approvePlanBudget(db.sql, { organizationId: ORG, planId: "plan_approval_list", budgetUsd: 2, actorId: "user_admin_a" });
    const second = await approvePlanBudget(db.sql, { organizationId: ORG, planId: "plan_approval_list", budgetUsd: 3, actorId: "user_admin_b" });
    assert.equal(first.status, "approved");
    assert.equal(second.status, "approved");

    const rows = await listBudgetApprovals(db.sql, ORG, "plan_approval_list", 10);
    assert.deepEqual(
      rows.map((row) => [row.actorId, row.previousUsd, row.approvedUsd]),
      [
        ["user_admin_b", 2, 3],
        ["user_admin_a", 0.5, 2],
      ],
    );
    assert.equal((await listBudgetApprovals(db.sql, ORG, "plan_approval_list", 1)).length, 1, "the limit applies");
    assert.deepEqual(await listBudgetApprovals(db.sql, OTHER, "plan_approval_list", 10), [], "another organization reads none");
  });

  test("two approvals made at the same time: each one that lands is recorded once, with the budget it replaced", async () => {
    await storedPlan("plan_approval_race", 0.5);
    await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_approval_race", catalog, handlers: standIn() });
    const outcomes = await Promise.all([
      approvePlanBudget(db.sql, { organizationId: ORG, planId: "plan_approval_race", budgetUsd: 2, actorId: "user_admin_a" }),
      approvePlanBudget(db.sql, { organizationId: ORG, planId: "plan_approval_race", budgetUsd: 3, actorId: "user_admin_b" }),
    ]);
    const landed = outcomes.filter((outcome) => outcome.status === "approved").length;
    assert.ok(landed >= 1, "at least one of them lands");
    if (db.engine === "pglite") {
      // PGlite runs one statement at a time, and both approvals read the budget before either writes. The first lands; the second read a
      // budget that has since changed, so it is refused by the compare-and-set (approval.ts) and writes nothing.
      assert.equal(outcomes[0]?.status, "approved");
      assert.equal(outcomes[1]?.status, "refused");
      assert.match(outcomes[1]?.status === "refused" ? outcomes[1].reasons.join(" ") : "", /the plan changed while the approval was made/);
    }

    const oldestFirst = (await listBudgetApprovals(db.sql, ORG, "plan_approval_race", 10)).reverse();
    assert.equal(oldestFirst.length, landed, "each approval that landed is recorded, and no refused one is");
    let budget = 0.5;
    for (const row of oldestFirst) {
      assert.equal(row.previousUsd, budget, "each record replaces the budget the record before it set");
      budget = row.approvedUsd;
    }
    assert.equal((await getPlan(db.sql, ORG, "plan_approval_race"))?.budgetUsd, budget, "the plan holds the budget of the last approval");
  });
});
