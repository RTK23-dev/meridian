import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { contentHash } from "../contracts/hash.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { approvePlanBudget } from "./approval.ts";
import { loadCatalog } from "./catalog.ts";
import { NODE_KINDS, orchestratorPlanSchema, type OrchestratorPlan } from "./contracts.ts";
import type { Handlers, NodeHandler } from "./execute.ts";
import { runStoredPlan } from "./run.ts";
import { createPlanDraft, getPlan, recordPlanOutcome } from "./store.ts";

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
    await createPlanDraft(db.sql, { id, organizationId: ORG, title: id, brief, orchestratorModel: "anthropic/claude-haiku-5.5", budgetUsd });
    await recordPlanOutcome(db.sql, { id, organizationId: ORG, plan: sample, reasons: [], catalogReadAt: null });
  }

  test("an approval raises a paused plan's budget, and the run then continues past the old allowance", async () => {
    await storedPlan("plan_approval_resume", 0.5);
    const paused = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_approval_resume", catalog, handlers: standIn() });
    assert.equal(paused.status, "paused", "a plan whose total passes the user's budget and its tolerance pauses");

    const approved = await approvePlanBudget(db.sql, { organizationId: ORG, planId: "plan_approval_resume", budgetUsd: 2 });
    assert.deepEqual(approved, { status: "approved", previousUsd: 0.5, budgetUsd: 2 });
    const stored = await getPlan(db.sql, ORG, "plan_approval_resume");
    assert.equal(stored?.budgetUsd, 2, "the set budget is the approved amount");
    assert.equal(stored?.plan?.budgetUsd, 2, "the plan's own budget is raised too, so the run's target is the approved amount");

    const resumed = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_approval_resume", catalog, handlers: standIn() });
    assert.equal(resumed.status, "complete");
  });

  test("an approval is refused unless the plan is paused, and the amount must be above the budget the plan has now", async () => {
    await storedPlan("plan_approval_ready", 0.5);
    const ready = await approvePlanBudget(db.sql, { organizationId: ORG, planId: "plan_approval_ready", budgetUsd: 2 });
    assert.equal(ready.status, "refused");
    assert.match(ready.status === "refused" ? ready.reasons.join(" ") : "", /only a plan paused for an approval/);

    await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_approval_ready", catalog, handlers: standIn() });
    const notAbove = await approvePlanBudget(db.sql, { organizationId: ORG, planId: "plan_approval_ready", budgetUsd: 0.5 });
    assert.equal(notAbove.status, "refused");
    assert.match(notAbove.status === "refused" ? notAbove.reasons.join(" ") : "", /must be above the \$0\.5000/);
    assert.equal((await getPlan(db.sql, ORG, "plan_approval_ready"))?.status, "paused", "a refused approval changes nothing");
  });

  test("another organization cannot approve a plan: the approval reads as not found", async () => {
    await storedPlan("plan_approval_scoped", 0.5);
    await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_approval_scoped", catalog, handlers: standIn() });
    const outcome = await approvePlanBudget(db.sql, { organizationId: OTHER, planId: "plan_approval_scoped", budgetUsd: 2 });
    assert.equal(outcome.status, "not_found");
    assert.equal((await getPlan(db.sql, ORG, "plan_approval_scoped"))?.budgetUsd, 0.5);
  });
});
