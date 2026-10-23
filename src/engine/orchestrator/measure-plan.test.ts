import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { contentHash } from "../contracts/hash.ts";
import { fixture, gatewayFor, json } from "../claude/test/helpers.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import type { WorkspaceBudgetSource, WorkspaceMonthBudget } from "../jobs/handlers/estimate-reserve.ts";
import { loadCatalog, type CatalogEntry } from "./catalog.ts";
import { NODE_KINDS } from "./contracts.ts";
import type { Handlers, NodeHandler } from "./execute.ts";
import { runStoredPlan } from "./run.ts";
import { planStoredDraft, type PlanScope } from "./service.ts";
import { createPlanDraft, getPlan } from "./store.ts";

const ORG = "org_measure_plan";
const OTHER_ORG = "org_measure_plan_other";
const NOW = "2026-10-23T10:00:00.000Z";
const BRIEF = {
  goal: "A 15 second product video",
  format: "a hook, a product shot, a call to action",
  userInputs: "the product is a water bottle",
  brand: { name: "Example", summary: "calm, blue, plain type" },
  budgetUsd: 10,
};
const recorded = loadCatalog(JSON.parse(readFileSync(new URL("./fixtures/openrouter-catalog-2026-10-20.json", import.meta.url), "utf8")));
const catalog = recorded.byId;

/** The plan the recorded planning answer holds. Its orchestrator is the model that answers, so a draft names that model. */
const replyPlan = (): Record<string, any> => JSON.parse((fixture("openrouter-orchestrator-plan-ok") as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content ?? "{}");
const orchestratorId: string = replyPlan().orchestrator.id;

function unpricedVideo(): CatalogEntry {
  const entry = [...catalog.values()].find((candidate) => candidate.kind === "video" && candidate.pricing.usdPerSecond1080p === null);
  if (entry === undefined) throw new Error("the recorded catalog lists a video model with no per-second price");
  return entry;
}

/** The recorded answer, with its shot step on the unpriced video model, a two-second length, and the planner's own figure for the step. */
function planningAnswer(videoId: string): ReturnType<typeof json> {
  const reply = structuredClone(fixture("openrouter-orchestrator-plan-ok")) as { choices: Array<{ message: { content: string } }> };
  const plan = JSON.parse(reply.choices[0]?.message.content ?? "{}");
  const shot = plan.nodes.find((node: { id: string }) => node.id === "shot_1");
  shot.model = { provider: "openrouter", id: videoId };
  shot.params.seconds = 2;
  shot.estimateUsd = 0.9;
  if (reply.choices[0]) reply.choices[0].message.content = JSON.stringify(plan);
  return json(200, reply);
}

/** A workspace month source with a fixed answer. It reads nothing. */
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

/** Every step's handler answers with no cost reported, so each step is charged its estimate (a video step its hold). */
function standIn(): Handlers {
  const handlers: Record<string, NodeHandler> = {};
  for (const kind of NODE_KINDS) {
    handlers[kind] = async ({ node }) => ({ outputHash: contentHash({ id: node.id, kind: node.kind }), costUsd: null });
  }
  return handlers as Handlers;
}

describe("a plan with an unpriced video step (D15): planning stores it with a note, and only a run in measure mode holds it", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, ORG);
    await seedWorkspace(db.sql, OTHER_ORG);
  });

  after(async () => {
    await db.close();
  });

  test("a draft becomes a ready plan with a note: its unpriced step has no cost, and the note says it needs measure mode", async () => {
    await createPlanDraft(db.sql, { id: "plan_measure_ready", organizationId: ORG, title: "Measured", brief: BRIEF, orchestratorModel: orchestratorId, budgetUsd: 10 });
    const ids = { request: "req_01JABCDEFGHJKMNPQRSTVWXYZ1", reservation: "res_01JABCDEFGHJKMNPQRSTVWXYZ1" };
    const video = unpricedVideo();
    const outcome = await planStoredDraft(scopeFor(db, [planningAnswer(video.id)], ids), "plan_measure_ready");
    assert.equal(outcome.status, "ready", "an unpriced video step is a note at planning, not a refusal");
    const stored = await getPlan(db.sql, ORG, "plan_measure_ready");
    assert.equal(stored?.status, "ready");
    assert.equal(stored?.plan?.nodes.find((node) => node.id === "shot_1")?.estimateUsd, null, "the step has no cost");
    assert.ok(
      stored?.reasons.some((note) => /^step shot_1: .+ has no per-second price in the listing, so the step needs measure mode/.test(note)),
      `the note is stored with the plan: ${stored?.reasons.join(" | ")}`,
    );
  });

  test("the run refuses the plan without measure mode, and completes it in measure mode, holding the step to the ceiling", async () => {
    const refused = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_measure_ready", catalog, handlers: standIn() });
    assert.equal(refused.status, "not_runnable");
    if (refused.status === "not_runnable") assert.match(refused.reasons.join("\n"), /needs measure mode, which an admin starts/);
    assert.equal((await getPlan(db.sql, ORG, "plan_measure_ready"))?.status, "ready", "a refused run leaves the plan ready");

    const measured = await runStoredPlan(db.sql, {
      organizationId: ORG,
      planId: "plan_measure_ready",
      catalog,
      handlers: standIn(),
      measure: { ceilingUsdPerSecond: 0.5 },
    });
    if (measured.status === "not_found" || measured.status === "not_runnable") throw new Error(`the measured run must start: ${measured.status}`);
    assert.equal(measured.status, "complete");
    const shot = measured.events.find((event) => event.nodeId === "shot_1" && event.state === "done");
    assert.equal(shot?.costUsd, 1, "two seconds at the $0.50 ceiling");
  });

  test("a step other than a video or avatar with no price is still refused at planning, and nothing is stored as a plan", async () => {
    await createPlanDraft(db.sql, { id: "plan_measure_text", organizationId: ORG, title: "Unpriced text", brief: BRIEF, orchestratorModel: orchestratorId, budgetUsd: 10 });
    const ids = { request: "req_01JABCDEFGHJKMNPQRSTVWXYZ2", reservation: "res_01JABCDEFGHJKMNPQRSTVWXYZ2" };
    const scriptId: string = replyPlan().nodes.find((node: { id: string }) => node.id === "script").model.id;
    const script = catalog.get(scriptId);
    if (script === undefined) throw new Error("the recorded catalog lists the script model");
    const unpricedText = new Map(catalog);
    unpricedText.set(scriptId, { ...script, pricing: { ...script.pricing, completionUsdPerToken: null } });
    const outcome = await planStoredDraft(scopeFor(db, [planningAnswer(unpricedVideo().id)], ids, unpricedText), "plan_measure_text");
    assert.equal(outcome.status, "refused");
    if (outcome.status === "refused") assert.match(outcome.reasons.join("\n"), /step script: .+ has no per-token price in the listing/);
    assert.equal((await getPlan(db.sql, ORG, "plan_measure_text"))?.plan, null);
  });
});
