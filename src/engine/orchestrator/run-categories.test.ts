import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { contentHash } from "../contracts/hash.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { categoryOf } from "./categories.ts";
import { loadCatalog } from "./catalog.ts";
import { NODE_KINDS, orchestratorPlanSchema, type OrchestratorPlan } from "./contracts.ts";
import type { Handlers, NodeHandler } from "./execute.ts";
import { runStoredPlan } from "./run.ts";
import { createPlanDraft, listPlanEvents, recordPlanOutcome } from "./store.ts";
import { validatePlan } from "./validate.ts";

const ORG = "org_run_categories";
const catalog = loadCatalog(JSON.parse(readFileSync(new URL("./fixtures/openrouter-catalog-2026-10-20.json", import.meta.url), "utf8"))).byId;
const sample: OrchestratorPlan = orchestratorPlanSchema.parse(JSON.parse(readFileSync(new URL("./fixtures/sample-plan.json", import.meta.url), "utf8")));

/** The copy steps of the sample plan in run order, with the estimates the engine prices them at (validate.ts). */
function copyStepsInRunOrder(): Array<{ id: string; estimateUsd: number }> {
  const checked = validatePlan(sample, catalog);
  if (!checked.ok) throw new Error(`the sample plan must validate: ${checked.reasons.join("; ")}`);
  const steps: Array<{ id: string; estimateUsd: number }> = [];
  for (const id of checked.order) {
    const node = checked.plan.nodes.find((candidate) => candidate.id === id);
    if (node !== undefined && categoryOf(node.kind) === "copy") steps.push({ id: node.id, estimateUsd: node.estimateUsd ?? 0 });
  }
  return steps;
}

/** Stand-in handlers for every kind. Each call is recorded by step id, and no cost is reported, so a step is charged its hold. */
function standIn(calls: string[]): Handlers {
  const handlers: Record<string, NodeHandler> = {};
  for (const kind of NODE_KINDS) {
    handlers[kind] = async ({ node }) => {
      calls.push(node.id);
      return { outputHash: contentHash({ id: node.id, kind: node.kind }), costUsd: null };
    };
  }
  return handlers as Handlers;
}

describe("the copy budget in the brief, checked by the run (owner direction 2026-10-23, D3, D12)", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, ORG);
  });

  after(async () => {
    await db.close();
  });

  /** A stored, ready plan whose brief sets a copy budget (a line), or leaves it unset. The brief is valid, as planning stores it. */
  async function storedPlan(id: string, copyBudgetUsd?: number): Promise<void> {
    const brief = {
      goal: "A short branded video",
      format: "a hook, a product shot, a call to action",
      userInputs: "",
      brand: { name: "Example", summary: "plain" },
      budgetUsd: sample.budgetUsd,
      ...(copyBudgetUsd === undefined ? {} : { copyBudgetUsd }),
    };
    await createPlanDraft(db.sql, { id, organizationId: ORG, title: id, brief, orchestratorModel: "anthropic/claude-haiku-5.5", budgetUsd: sample.budgetUsd });
    await recordPlanOutcome(db.sql, { id, organizationId: ORG, plan: sample, reasons: [], catalogReadAt: null });
  }

  test("a copy line pauses the run at the copy step that starts at it, and the stored copy output keeps its category", async () => {
    const [first, second] = copyStepsInRunOrder();
    if (first === undefined || second === undefined) throw new Error("the sample plan has two copy steps");
    // The copy line is the first copy step's estimate: it starts below the line, and the second starts at it.
    await storedPlan("plan_copy_pause", first.estimateUsd);
    const calls: string[] = [];
    const outcome = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_copy_pause", catalog, handlers: standIn(calls) });

    assert.equal(outcome.status, "paused");
    assert.ok(calls.includes(first.id), "the first copy step runs");
    assert.ok(!calls.includes(second.id), "the second copy step is not called");
    const events = await listPlanEvents(db.sql, ORG, "plan_copy_pause", 0);
    const pause = events.filter((event) => event.state === "paused").at(-1);
    assert.equal(pause?.nodeId, second.id);
    assert.match(pause?.reason ?? "", /^copy budget reached, project not finished/);

    const outputs = (await db.sql`select category from orchestrator_step_outputs where plan_id = ${"plan_copy_pause"}`) as Array<{ category: string | null }>;
    assert.equal(outputs.filter((row) => row.category === "copy").length, 1, "the first copy step's output is stored in the copy category");
  });

  test("a re-run counts the copy money the first run stored, so it pauses again without calling the step", async () => {
    const [first, second] = copyStepsInRunOrder();
    if (first === undefined || second === undefined) throw new Error("the sample plan has two copy steps");
    await storedPlan("plan_copy_rerun", first.estimateUsd);
    await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_copy_rerun", catalog, handlers: standIn([]) });

    const calls: string[] = [];
    const again = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_copy_rerun", catalog, handlers: standIn(calls) });
    assert.equal(again.status, "paused");
    assert.ok(!calls.includes(second.id), "the second copy step is not called on the re-run either");
    assert.ok(!calls.includes(first.id), "the first copy step is reused from its stored output");
  });

  test("a plan whose brief sets no copy budget is held by the total alone: its copy steps are delegated", async () => {
    await storedPlan("plan_copy_delegated");
    const outcome = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_copy_delegated", catalog, handlers: standIn([]) });
    assert.equal(outcome.status, "complete");
  });

  test("a brief that does not match its contract refuses the run, so no category budget is guessed", async () => {
    await createPlanDraft(db.sql, {
      id: "plan_copy_bad_brief",
      organizationId: ORG,
      title: "bad brief",
      brief: { goal: "g" },
      orchestratorModel: "anthropic/claude-haiku-5.5",
      budgetUsd: sample.budgetUsd,
    });
    await recordPlanOutcome(db.sql, { id: "plan_copy_bad_brief", organizationId: ORG, plan: sample, reasons: [], catalogReadAt: null });
    const calls: string[] = [];
    const outcome = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_copy_bad_brief", catalog, handlers: standIn(calls) });
    assert.equal(outcome.status, "not_runnable");
    assert.match(outcome.status === "not_runnable" ? outcome.reasons.join(" ") : "", /brief/);
    assert.deepEqual(calls, []);
  });
});
