import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { contentHash } from "../contracts/hash.ts";
import type { AssetJob } from "../assets/job.ts";
import type { ProduceInput } from "../assets/router.ts";
import type { WorkspaceBudgetSource } from "../jobs/handlers/estimate-reserve.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { queueAssetJob } from "./asset-poll.ts";
import { loadCatalog } from "./catalog.ts";
import { NODE_KINDS, type OrchestratorPlan } from "./contracts.ts";
import { examplePlan } from "./example.ts";
import type { Handlers, NodeHandler } from "./execute.ts";
import { editStoredPlan, runStoredPlan, type RunOutcome } from "./run.ts";
import type { RunBudget } from "./run-budget.ts";
import { createPlanDraft, getPlan, listPlanEvents, recordPlanOutcome } from "./store.ts";
import { KIND_CATALOG, validatePlan } from "./validate.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";

const ORG = "org_run_a";
const OTHER = "org_run_b";
const NOW = "2026-10-22T10:00:00.000Z";
const catalog = loadCatalog(JSON.parse(readFileSync(new URL("./fixtures/openrouter-catalog-2026-10-20.json", import.meta.url), "utf8"))).byId;

/** A job the run queued, as the production handlers record it. Only its hold and its step matter to these tests. */
const QUEUED_INPUT = { spec: { shotId: "shot_0a", modelClass: "video.budget" }, requestId: "req_1", reservationId: "res_1" } as unknown as ProduceInput;
const QUEUED_JOB = { idempotencyKey: "job-1", jobRef: "provider-job-1" } as unknown as AssetJob;

/** A workspace whose month has a known budget. */
function monthOf(usd: number): WorkspaceBudgetSource {
  return {
    async monthBudget() {
      return { status: "known", usd } as Awaited<ReturnType<WorkspaceBudgetSource["monthBudget"]>>;
    },
  };
}

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
    // The first run's spend stays spent: $1.0846 is committed, and the edited shot's $1.20 hold (six seconds) would take it past the $2 budget.
    assert.equal(outcome.status, "paused");
    assert.equal(calls.includes("shot_1"), false, "the paused shot is not called");
    assert.match(
      outcome.status === "paused" ? (outcome.events.find((event) => event.nodeId === "shot_1" && event.state === "paused")?.reason ?? "") : "",
      /^budget reached, project not finished: the next step's hold of \$1\.2000 would take the spend past the \$2\.0000 budget \(committed \$1\.0846\)$/,
    );
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

  test("a plan whose budget is above the budget the user set is held to the user's budget: a paid step whose hold does not fit pauses before its call", async () => {
    assert.ok(examplePlan.budgetUsd > 0.0001, "the example plan asks for more than the budget this test sets");
    await createPlanDraft(db.sql, { id: "plan_run_overbudget", organizationId: ORG, title: "over", brief: storedBrief(0.0001), orchestratorModel: examplePlan.orchestrator.id, budgetUsd: 0.0001 });
    await recordPlanOutcome(db.sql, { id: "plan_run_overbudget", organizationId: ORG, plan: examplePlan, reasons: [], catalogReadAt: null });
    const calls: string[] = [];
    const outcome = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_run_overbudget", catalog, handlers: standIn(calls) });
    // The line is the $0.0001 the user set. The analysis step's hold is larger than that, so it does not fit: the run pauses before its call.
    assert.notEqual(outcome.status, "not_runnable");
    assert.equal(outcome.status, "paused", "the first paid step's hold does not fit the line the user set");
    assert.equal(calls.includes("analyze_ref"), false, "no request is made for the step whose hold does not fit");
    if (outcome.status === "paused") {
      assert.ok(
        outcome.events.some(
          (event) =>
            event.state === "paused" &&
            /^budget reached, project not finished: the next step's hold of \$[0-9.]+ would take the spend past the \$0\.0001 budget \(committed \$0\.0000\)$/.test(
              event.reason ?? "",
            ),
        ),
        "the pause reads the D17 reason",
      );
    }
  });

  /** The engine requests the orchestrator's runs have opened in this workspace: a run with a reservation opens one. */
  async function countRuns(): Promise<number> {
    const rows = (await db.sql`select count(*) as n from engine_requests where organization_id = ${ORG} and format_id = 'orchestrator_run'`) as Array<{ n: string | number }>;
    return Number(rows[0]?.n ?? 0);
  }

  test("a later run counts a job still waiting at its provider: its step reports queued, submits nothing, and adds no spend", async () => {
    await storedReadyPlan("plan_run_waiting");
    // The video's job waits at its provider with the example's hold for it ($0.90). That hold is in the run's starting spend.
    await queueAssetJob(db.sql, ORG, { planId: "plan_run_waiting", stepId: "shot_1", cacheKey: "key-run-waiting", kind: "video", input: QUEUED_INPUT, job: QUEUED_JOB, runAfterMs: 60_000, hold: 1, seconds: 5 });
    const calls: string[] = [];
    const outcome = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_run_waiting", catalog, handlers: standIn(calls) });
    assert.equal(outcome.status, "incomplete", "the steps that read the waiting video wait for its poll");
    assert.equal(outcome.events.filter((event) => event.nodeId === "shot_1").at(-1)?.state, "queued");
    assert.equal(calls.includes("shot_1"), false, "nothing is submitted for the waiting job");
    // The waiting hold is the validated $1.00 for the five-second clip. The other steps cost $0.0846, so the spend is $1.0846, counted once.
    assert.ok(Math.abs(spentOf(outcome) - 1.0846) < 1e-3, `spent ${spentOf(outcome)}`);
  });

  test("a waiting job's hold can take the spend to the line before the run's own steps: the run pauses at its first paid step", async () => {
    await createPlanDraft(db.sql, { id: "plan_run_waiting_line", organizationId: ORG, title: "waiting line", brief: storedBrief(0.9), orchestratorModel: examplePlan.orchestrator.id, budgetUsd: 0.9 });
    await recordPlanOutcome(db.sql, { id: "plan_run_waiting_line", organizationId: ORG, plan: examplePlan, reasons: [], catalogReadAt: null });
    await queueAssetJob(db.sql, ORG, { planId: "plan_run_waiting_line", stepId: "shot_1", cacheKey: "key-run-waiting-line", kind: "video", input: QUEUED_INPUT, job: QUEUED_JOB, runAfterMs: 60_000, hold: 0.9, seconds: 5 });
    // The line is $0.90, which the waiting $0.90 hold reaches before any step of this run starts.
    const calls: string[] = [];
    const outcome = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_run_waiting_line", catalog, handlers: standIn(calls) });
    assert.equal(outcome.status, "paused");
    assert.equal(calls.includes("analyze_ref"), false, "the waiting hold fills the $0.90 line, so no paid step starts");
    assert.match(
      outcome.status === "paused" ? (outcome.events.find((event) => event.nodeId === "analyze_ref" && event.state === "paused")?.reason ?? "") : "",
      /^budget reached, project not finished: the next step's hold of \$[0-9.]+ would take the spend past the \$0\.9000 budget \(committed \$0\.9000\)$/,
    );
  });

  test("a waiting job with no recorded hold refuses the run until its poll settles it, and names its step", async () => {
    await storedReadyPlan("plan_run_unrecorded");
    await db.sql`
      insert into orchestrator_asset_jobs (id, organization_id, plan_id, request_id, reservation_id, step_id, cache_key, kind, input, job)
      values (${globalThis.crypto.randomUUID()}, ${ORG}, 'plan_run_unrecorded', 'req_1', 'res_1', 'shot_1', 'key-unrecorded', 'video',
        ${JSON.stringify(QUEUED_INPUT)}::jsonb, ${JSON.stringify(QUEUED_JOB)}::jsonb)
    `;
    const calls: string[] = [];
    const outcome = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_run_unrecorded", catalog, handlers: standIn(calls) });
    assert.equal(outcome.status, "not_runnable");
    assert.match(outcome.status === "not_runnable" ? outcome.reasons.join(" ") : "", /^a queued job has no recorded hold, so the run cannot count its money; the poll settles it first\. Steps: shot_1\.$/);
    assert.deepEqual(calls, [], "nothing is called");
    assert.equal((await getPlan(db.sql, ORG, "plan_run_unrecorded"))?.status, "ready", "the plan is ready again");
  });

  test("a run whose spend is already at the line opens no reservation: its handlers are made without one, and it pauses at its first paid step", async () => {
    const checked = validatePlan(examplePlan, catalog);
    if (!checked.ok) throw new Error("the example plan must validate");
    const paid = checked.order.map((id) => checked.plan.nodes.find((node) => node.id === id)).find((node) => node !== undefined && KIND_CATALOG[node.kind] !== undefined);
    if (paid === undefined || paid.estimateUsd === null) throw new Error("the example plan has a paid step with a price");
    // The line is the first paid step's own hold: after that step runs, the spend is at the line, so the next run opens no reservation.
    const line = paid.estimateUsd;
    await createPlanDraft(db.sql, { id: "plan_run_at_line", organizationId: ORG, title: "at line", brief: storedBrief(line), orchestratorModel: examplePlan.orchestrator.id, budgetUsd: line });
    await recordPlanOutcome(db.sql, { id: "plan_run_at_line", organizationId: ORG, plan: examplePlan, reasons: [], catalogReadAt: null });
    const reservedFor: Array<RunBudget | null> = [];
    const budget = {
      workspaceBudget: monthOf(100),
      now: () => NOW,
      handlersFor: (handle: RunBudget | null) => {
        reservedFor.push(handle);
        return standIn([]);
      },
    };
    const first = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_run_at_line", catalog, budget });
    assert.equal(first.status, "paused");
    assert.notEqual(reservedFor[0], null, "the first run is below the line, so it takes a reservation");
    const runsBefore = await countRuns();

    const second = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_run_at_line", catalog, budget });
    assert.equal(second.status, "paused");
    assert.equal(reservedFor.at(-1), null, "the line is reached: no reservation is opened");
    assert.equal(await countRuns(), runsBefore, "no request row is written for the second run");
    assert.match(
      second.status === "paused" ? (second.events.find((event) => event.state === "paused")?.reason ?? "") : "",
      /^budget reached, project not finished: the next step's hold of \$[0-9.]+ would take the spend past the \$[0-9.]+ budget/,
    );
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
