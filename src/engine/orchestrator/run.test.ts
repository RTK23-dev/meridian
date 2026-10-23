import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { contentHash } from "../contracts/hash.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { loadCatalog } from "./catalog.ts";
import { NODE_KINDS, type OrchestratorPlan } from "./contracts.ts";
import { examplePlan } from "./example.ts";
import type { Handlers, NodeHandler } from "./execute.ts";
import { editStoredPlan, runStoredPlan, type RunOutcome } from "./run.ts";
import { createPlanDraft, getPlan, listPlanEvents, recordPlanOutcome } from "./store.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";

const ORG = "org_run_a";
const OTHER = "org_run_b";
const catalog = loadCatalog(JSON.parse(readFileSync(new URL("./fixtures/openrouter-catalog-2026-10-20.json", import.meta.url), "utf8"))).byId;

/** A brief as planning stores it. A run checks the stored brief against its contract before it runs (run.ts), so the fixtures are valid briefs. */
function storedBrief(budgetUsd: number, extra: Record<string, number> = {}) {
  return { goal: "A short branded video", format: "a hook, a product shot, a call to action", userInputs: "", brand: { name: "Example", summary: "plain" }, budgetUsd, ...extra };
}

type Tagged = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

/** The same database, with every write to one table refused. Reads and the other writes go through unchanged. */
function failingWritesTo(table: string, sql: Sql): Sql {
  const tagged = sql as unknown as Tagged;
  const wrapped: Tagged = (strings, ...values) =>
    strings.join("?").includes(`insert into ${table}`) ? Promise.reject(new Error("the database refused the write")) : tagged(strings, ...values);
  return wrapped as unknown as Sql;
}

/** The spend of a run that ran (a run that did not run has none). */
function spentOf(outcome: RunOutcome): number {
  return outcome.status === "complete" || outcome.status === "paused" || outcome.status === "incomplete" ? outcome.spentUsd : 0;
}

/** Stand-in handlers for every kind: deterministic outputs, no provider. Each call is recorded by step id. */
function standIn(calls: string[], costUsd: number | null = null, overrides: Partial<Record<string, NodeHandler>> = {}): Handlers {
  const handlers: Record<string, NodeHandler> = {};
  for (const kind of NODE_KINDS) {
    handlers[kind] =
      overrides[kind] ??
      (async ({ node }) => {
        calls.push(node.id);
        return { outputHash: contentHash({ id: node.id, kind: node.kind, params: node.params, model: node.model?.id ?? null }), costUsd };
      });
  }
  return handlers as Handlers;
}

describe("orchestrator runner over the stored plan (migration 0108)", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, ORG);
    await seedWorkspace(db.sql, OTHER);
  });

  after(async () => {
    await db.close();
  });

  async function storedReadyPlan(id: string, plan: OrchestratorPlan = examplePlan): Promise<void> {
    await createPlanDraft(db.sql, { id, organizationId: ORG, title: id, brief: storedBrief(plan.budgetUsd), orchestratorModel: "anthropic/claude-haiku-5.5", budgetUsd: plan.budgetUsd });
    await recordPlanOutcome(db.sql, { id, organizationId: ORG, plan, reasons: [], catalogReadAt: null });
  }

  test("a complete run records its events in order and its plan is complete", async () => {
    await storedReadyPlan("plan_run_complete");
    const calls: string[] = [];
    const outcome = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_run_complete", catalog, handlers: standIn(calls) });
    assert.equal(outcome.status, "complete");
    assert.equal(calls.length, examplePlan.nodes.length);
    const stored = await getPlan(db.sql, ORG, "plan_run_complete");
    assert.equal(stored?.status, "complete");
    const events = await listPlanEvents(db.sql, ORG, "plan_run_complete", 0);
    assert.equal(events.length, 30, "ten planned, ten running, ten done");
    assert.deepEqual(events.slice(0, 10).map((event) => event.state), examplePlan.nodes.map(() => "planned"));
  });

  test("a second run reuses every stored output: no handler is called, and the spend is not counted twice", async () => {
    const first = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_run_complete", catalog, handlers: standIn([]) });
    const calls: string[] = [];
    const second = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_run_complete", catalog, handlers: standIn(calls) });
    assert.equal(second.status, "complete");
    assert.deepEqual(calls, []);
    const firstSpent = spentOf(first);
    const secondSpent = spentOf(second);
    assert.equal(secondSpent, firstSpent);
    assert.ok(Math.abs(secondSpent - 1.0846) < 1e-3, `the spend is the plan's estimates: ${secondSpent}`);
  });

  test("after one edit, only the edited step and what reads it run again; the rest are reused", async () => {
    // A larger budget than the example's: the first run's spend and the edited shot must both fit.
    await storedReadyPlan("plan_run_edit", { ...examplePlan, budgetUsd: 5 });
    await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_run_edit", catalog, handlers: standIn([]) });
    const edit = await editStoredPlan(db.sql, {
      organizationId: ORG,
      planId: "plan_run_edit",
      catalog,
      nodeId: "shot_1",
      change: { params: { seconds: 6, aspect: "9:16", resolution: "1080p" } },
    });
    assert.equal(edit.status, "edited");
    const calls: string[] = [];
    const events: string[] = [];
    const outcome = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_run_edit", catalog, handlers: standIn(calls) });
    assert.equal(outcome.status, "complete");
    assert.deepEqual([...calls].sort(), ["compose", "edit", "render", "shot_1"]);
    for (const event of outcome.events) if (event.state === "cache_hit") events.push(event.nodeId);
    assert.deepEqual([...events].sort(), ["analyze_ref", "brand", "hero_still", "ref_viral", "script", "voice"]);
  });

  test("a re-run after an edit counts the money the earlier run already spent, so it pauses before an overrun", async () => {
    await storedReadyPlan("plan_run_edit_budget");
    await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_run_edit_budget", catalog, handlers: standIn([]) });
    const edit = await editStoredPlan(db.sql, {
      organizationId: ORG,
      planId: "plan_run_edit_budget",
      catalog,
      nodeId: "shot_1",
      change: { params: { seconds: 6, aspect: "9:16", resolution: "1080p" } },
    });
    assert.equal(edit.status, "edited");
    const calls: string[] = [];
    const outcome = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_run_edit_budget", catalog, handlers: standIn(calls) });
    // The first run's spend stays spent: it is counted with the re-run of the shot, which would take the plan past its $2 budget.
    assert.equal(outcome.status, "paused");
    assert.equal(calls.includes("shot_1"), false, "the paused shot is not called");
  });

  test("an edit the engine refuses changes nothing: the plan is the same, and the reasons are given", async () => {
    await storedReadyPlan("plan_run_refused_edit");
    const before = await getPlan(db.sql, ORG, "plan_run_refused_edit");
    const edit = await editStoredPlan(db.sql, {
      organizationId: ORG,
      planId: "plan_run_refused_edit",
      catalog,
      nodeId: "hero_still",
      change: { model: { provider: "openrouter", id: "vendor/not-real" } },
    });
    assert.equal(edit.status, "refused");
    if (edit.status === "refused") assert.match(edit.reasons.join("\n"), /hero_still: vendor\/not-real is not in the live catalog/);
    assert.deepEqual((await getPlan(db.sql, ORG, "plan_run_refused_edit"))?.plan, before?.plan);
  });

  test("a step with no handler is not_connected: nothing is called for it, its readers are skipped, and the run is incomplete", async () => {
    await storedReadyPlan("plan_run_missing");
    const calls: string[] = [];
    const handlers = standIn(calls);
    delete handlers.video;
    const outcome = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_run_missing", catalog, handlers });
    assert.equal(outcome.status, "incomplete");
    const events = outcome.status === "incomplete" || outcome.status === "complete" || outcome.status === "paused" ? outcome.events : [];
    assert.ok(events.some((event) => event.nodeId === "shot_1" && event.state === "not_connected"));
    assert.ok(events.some((event) => event.nodeId === "edit" && event.state === "skipped"));
    assert.equal(calls.includes("shot_1"), false);
    assert.equal((await getPlan(db.sql, ORG, "plan_run_missing"))?.status, "incomplete");
  });

  test("the budget is a limit on the plan: spend that reaches it pauses the run before the next paid step", async () => {
    await storedReadyPlan("plan_run_budget");
    const calls: string[] = [];
    const outcome = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_run_budget", catalog, handlers: standIn(calls, 1.5) });
    assert.equal(outcome.status, "paused");
    assert.equal((await getPlan(db.sql, ORG, "plan_run_budget"))?.status, "paused");
    assert.equal(calls.includes("hero_still"), false, "the step that would overrun is not called");
    assert.ok(spentOf(outcome) <= 2 + 1.5, "the spend stops at the step that would overrun");
  });

  test("another organization cannot run or edit the plan: both are not found, and nothing is called", async () => {
    const calls: string[] = [];
    assert.deepEqual(await runStoredPlan(db.sql, { organizationId: OTHER, planId: "plan_run_complete", catalog, handlers: standIn(calls) }), { status: "not_found" });
    assert.deepEqual(
      await editStoredPlan(db.sql, { organizationId: OTHER, planId: "plan_run_complete", catalog, nodeId: "shot_1", change: { params: { seconds: 1 } } }),
      { status: "not_found" },
    );
    assert.deepEqual(calls, []);
  });

  test("a draft that has not been planned, or a refused plan, is not runnable, and says why", async () => {
    await createPlanDraft(db.sql, { id: "plan_run_draft", organizationId: ORG, title: "d", brief: storedBrief(2), orchestratorModel: "anthropic/claude-haiku-5.5", budgetUsd: 2 });
    const outcome = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_run_draft", catalog, handlers: standIn([]) });
    assert.equal(outcome.status, "not_runnable");
    if (outcome.status === "not_runnable") assert.match(outcome.reasons[0] ?? "", /no checked plan to run/);
  });

  test("a plan whose budget is above the budget the user set is held to the user's budget and its tolerance: it waits at the step that passes the allowance", async () => {
    assert.ok(examplePlan.budgetUsd > 0.01, "the example plan asks for more than the budget this test sets");
    await createPlanDraft(db.sql, { id: "plan_run_overbudget", organizationId: ORG, title: "over", brief: storedBrief(0.01), orchestratorModel: "anthropic/claude-haiku-5.5", budgetUsd: 0.01 });
    await recordPlanOutcome(db.sql, { id: "plan_run_overbudget", organizationId: ORG, plan: examplePlan, reasons: [], catalogReadAt: null });
    const calls: string[] = [];
    const outcome = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_run_overbudget", catalog, handlers: standIn(calls) });
    // The allowance is the $0.01 the user set plus the 25-cent floor of the initial tolerance: $0.26.
    assert.notEqual(outcome.status, "not_runnable");
    assert.equal(outcome.status, "paused", "the first paid step past $0.26 waits for an approval");
    if (outcome.status === "paused") assert.ok(outcome.events.some((event) => event.state === "paused" && /past the \$0\.2600 allowance/.test(event.reason ?? "")));
  });

  test("a database error during a run leaves the plan ready, so a later run is not refused, and the error is the one thrown", async () => {
    await storedReadyPlan("plan_run_dberror");
    const failing = failingWritesTo("orchestrator_plan_events", db.sql);
    await assert.rejects(runStoredPlan(failing, { organizationId: ORG, planId: "plan_run_dberror", catalog, handlers: standIn([]) }), /the database refused the write/);
    assert.equal((await getPlan(db.sql, ORG, "plan_run_dberror"))?.status, "ready");
    const again = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_run_dberror", catalog, handlers: standIn([]) });
    assert.notEqual(again.status, "not_runnable", "the plan can be run again");
  });
});
