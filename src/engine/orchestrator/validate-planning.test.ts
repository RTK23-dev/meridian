import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadCatalog, type CatalogEntry } from "./catalog.ts";
import { orchestratorPlanSchema, type OrchestratorPlan } from "./contracts.ts";
import { validatePlan } from "./validate.ts";

const sample = JSON.parse(readFileSync(new URL("./fixtures/sample-plan.json", import.meta.url), "utf8"));
const catalog = loadCatalog(JSON.parse(readFileSync(new URL("./fixtures/openrouter-catalog-2026-10-20.json", import.meta.url), "utf8"))).byId;

/** A copy of the sample plan, changed by `edit`, parsed the way a model's output is parsed. */
function planWith(edit: (plan: Record<string, any>) => void): OrchestratorPlan {
  const copy = structuredClone(sample);
  edit(copy);
  return orchestratorPlanSchema.parse(copy);
}

const step = (plan: Record<string, any>, id: string) => plan.nodes.find((node: { id: string }) => node.id === id);

/** A video model of the recorded catalog with no per-second price: a step on it has no price basis. */
function unpricedVideo(): CatalogEntry {
  const entry = [...catalog.values()].find((candidate) => candidate.kind === "video" && candidate.pricing.usdPerSecond1080p === null);
  if (entry === undefined) throw new Error("the recorded catalog lists a video model with no per-second price");
  return entry;
}

/** The sample plan with its shot step on the unpriced video model, and the planner's own figure for that step. */
function unpricedShot(length = 5): OrchestratorPlan {
  const video = unpricedVideo();
  return planWith((p) => {
    step(p, "shot_1").model = { provider: "openrouter", id: video.id };
    step(p, "shot_1").estimateUsd = 0.9;
    step(p, "shot_1").params.seconds = length;
  });
}

test("planning keeps an unpriced video step: it has no cost, the plan is noted as needing measure mode, and the run still refuses it", () => {
  const plan = unpricedShot();
  const planned = validatePlan(plan, catalog, { planning: true });
  assert.equal(planned.ok, true, "at planning the step is a note, not a refusal");
  if (!planned.ok) return;
  assert.equal(planned.plan.nodes.find((node) => node.id === "shot_1")?.estimateUsd, null, "the step has no cost, so the planner's figure is not kept");
  assert.ok(
    planned.notes.some((note) => /^step shot_1: .+ has no per-second price in the listing, so the step needs measure mode/.test(note)),
    `the note names the step: ${planned.notes.join(" | ")}`,
  );

  const run = validatePlan(plan, catalog);
  assert.equal(run.ok, false, "the run refuses it without measure mode");
  if (!run.ok) assert.match(run.reasons.join("\n"), /step shot_1: .+ has no per-second price in the listing, so the step needs measure mode, which an admin starts/);
});

test("planning refuses every other unpriced step: a step with no per-token price, and a video step with no usable length", () => {
  // The sample plan's script step names a text model of the recorded catalog: that step is the one made unpriced.
  const scriptId: string = step(sample, "script").model.id;
  const scriptModel = catalog.get(scriptId);
  if (scriptModel === undefined) throw new Error("the recorded catalog lists the script model");
  const unpricedText = new Map(catalog);
  unpricedText.set(scriptModel.id, { ...scriptModel, pricing: { ...scriptModel.pricing, completionUsdPerToken: null } });
  const textRefused = validatePlan(planWith(() => {}), unpricedText, { planning: true });
  assert.equal(textRefused.ok, false, "a text step with no per-token price is still refused at planning");
  if (!textRefused.ok) assert.match(textRefused.reasons.join("\n"), /step script: .+ has no per-token price in the listing/);

  const noLength = validatePlan(unpricedShot(0), catalog, { planning: true });
  assert.equal(noLength.ok, false, "a video step with no usable length is still refused at planning");
  if (!noLength.ok) assert.match(noLength.reasons.join("\n"), /step shot_1: params\.seconds must be a number from 0 to 60/);
});

test("with measure mode on, planning holds the unpriced video step to its ceiling: a cost, and no note", () => {
  const measured = validatePlan(unpricedShot(), catalog, { planning: true, measure: { ceilingUsdPerSecond: 0.5 } });
  assert.equal(measured.ok, true);
  if (!measured.ok) return;
  assert.equal(measured.plan.nodes.find((node) => node.id === "shot_1")?.estimateUsd, 2.5, "five seconds at the $0.50 ceiling");
  assert.equal(measured.notes.some((note) => /needs measure mode/.test(note)), false, "a held step needs no note");
});
