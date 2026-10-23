import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { contentHash } from "../contracts/hash.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { loadCatalog, type CatalogEntry } from "./catalog.ts";
import { NODE_KINDS, orchestratorPlanSchema, type OrchestratorPlan } from "./contracts.ts";
import { editStoredPlan, runStoredPlan } from "./run.ts";
import type { Handlers, NodeHandler } from "./execute.ts";
import { createPlanDraft, getPlan, recordPlanOutcome } from "./store.ts";

const ORG = "org_measure_edit";
const BRIEF = { goal: "A short branded video", format: "a hook, a product shot, a call to action", userInputs: "", brand: { name: "Example", summary: "plain" }, budgetUsd: 10 };
const catalog = loadCatalog(JSON.parse(readFileSync(new URL("./fixtures/openrouter-catalog-2026-10-20.json", import.meta.url), "utf8"))).byId;
const sample: OrchestratorPlan = orchestratorPlanSchema.parse(JSON.parse(readFileSync(new URL("./fixtures/sample-plan.json", import.meta.url), "utf8")));

/** A video model of the recorded catalog with no per-second price. */
function unpricedVideo(): CatalogEntry {
  const entry = [...catalog.values()].find((candidate) => candidate.kind === "video" && candidate.pricing.usdPerSecond1080p === null);
  if (entry === undefined) throw new Error("the recorded catalog lists a video model with no per-second price");
  return entry;
}

/** Every step's handler answers with no cost reported, so each step is charged its estimate (a video step its hold). */
function standIn(): Handlers {
  const handlers: Record<string, NodeHandler> = {};
  for (const kind of NODE_KINDS) {
    handlers[kind] = async ({ node }) => ({ outputHash: contentHash({ id: node.id, kind: node.kind }), costUsd: null });
  }
  return handlers as Handlers;
}

describe("an edit to an unpriced step (D15): the planning check accepts a video step with a note, and the run needs measure mode", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, ORG);
    await createPlanDraft(db.sql, { id: "plan_edit_video", organizationId: ORG, title: "Edited", brief: BRIEF, orchestratorModel: sample.orchestrator.id, budgetUsd: 10 });
    await recordPlanOutcome(db.sql, { id: "plan_edit_video", organizationId: ORG, plan: sample, reasons: [], catalogReadAt: null });
  });

  after(async () => {
    await db.close();
  });

  test("an edit that puts a video step on an unpriced model is accepted and stored with a note; the run refuses it without measure mode", async () => {
    const video = unpricedVideo();
    const outcome = await editStoredPlan(db.sql, {
      organizationId: ORG,
      planId: "plan_edit_video",
      catalog,
      nodeId: "shot_1",
      change: { model: { provider: "openrouter", id: video.id }, params: { seconds: 2, aspect: "9:16", resolution: "1080p" } },
    });
    assert.equal(outcome.status, "edited", JSON.stringify(outcome));
    const stored = await getPlan(db.sql, ORG, "plan_edit_video");
    assert.equal(stored?.status, "ready");
    assert.equal(stored?.plan?.nodes.find((node) => node.id === "shot_1")?.estimateUsd, null, "the step has no cost until measure mode holds it");
    assert.ok(
      stored?.reasons.some((note) => /^step shot_1: .+ has no per-second price in the listing, so the step needs measure mode/.test(note)),
      `the edit stores its note with the plan: ${stored?.reasons.join(" | ")}`,
    );

    const refused = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_edit_video", catalog, handlers: standIn() });
    assert.equal(refused.status, "not_runnable");
    if (refused.status === "not_runnable") assert.match(refused.reasons.join("\n"), /needs measure mode, which an admin starts/);
  });

  test("the same plan runs in measure mode, and the edited step is held to the ceiling times its length", async () => {
    const run = await runStoredPlan(db.sql, { organizationId: ORG, planId: "plan_edit_video", catalog, handlers: standIn(), measure: { ceilingUsdPerSecond: 0.5 } });
    if (run.status === "not_found" || run.status === "not_runnable") throw new Error(`the measured run must start: ${run.status}`);
    assert.equal(run.status, "complete");
    assert.equal(run.events.find((event) => event.nodeId === "shot_1" && event.state === "done")?.costUsd, 1, "two seconds at the $0.50 ceiling");
  });

  test("an edit that puts a text step on a model with no per-token price is still refused, and nothing is written", async () => {
    const analysisId: string = sample.nodes.find((node) => node.id === "analyze_ref")?.model?.id ?? "";
    const analysis = catalog.get(analysisId);
    if (analysis === undefined) throw new Error("the recorded catalog lists the analysis model");
    const unpricedText = new Map(catalog);
    unpricedText.set(analysisId, { ...analysis, pricing: { ...analysis.pricing, promptUsdPerToken: null } });
    const before = await getPlan(db.sql, ORG, "plan_edit_video");
    const outcome = await editStoredPlan(db.sql, { organizationId: ORG, planId: "plan_edit_video", catalog: unpricedText, nodeId: "analyze_ref", change: { params: { task: "format_structure", max_tokens: 100 } } });
    assert.equal(outcome.status, "refused");
    if (outcome.status === "refused") assert.match(outcome.reasons.join("\n"), /step analyze_ref: .+ has no per-token price in the listing/);
    assert.deepEqual(await getPlan(db.sql, ORG, "plan_edit_video"), before, "a refused edit changes nothing");
  });
});
