// The Models tab's view: every task lands in a group, a task's state is the server's own, one pick for several tasks offers only the
// models all of them can use, the picker groups by provider with the main ones first, and a multi-task save reports each refusal.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bulkSummary,
  fallbackText,
  groupByProvider,
  groupTasks,
  matchesSearch,
  priceLine,
  setupCounts,
  sharedModels,
  shortName,
  taskState,
  usd,
  type CatalogueModel,
  type TaskChoice,
} from "./models-model.ts";

const task = (id: string, extra: Partial<TaskChoice> = {}): TaskChoice => ({
  task: id,
  label: id,
  description: "",
  needsImage: false,
  saved: null,
  deploymentDefault: null,
  auto: null,
  ...extra,
});
const saved = { modelId: "anthropic/claude-top", updatedAt: "2026-11-01T00:00:00.000Z", updatedBy: "u" };
const model = (id: string, name: string, suitsTasks: string[], prompt = 1, completion = 5): CatalogueModel => ({
  id,
  name,
  takes: ["text"],
  promptUsdPerMillionTokens: prompt,
  completionUsdPerMillionTokens: completion,
  suitsTasks,
});

describe("models view", () => {
  it("puts each task in its group, in order, and a task no group names under More", () => {
    const groups = groupTasks([task("vision"), task("copy"), task("brain_suggest"), task("direction_judge"), task("transcription")]);
    assert.deepEqual(groups.map((group) => [group.id, group.tasks.map((item) => item.task)]), [
      ["writing", ["copy", "direction_judge"]],
      ["research", ["brain_suggest"]],
      ["images", ["vision"]],
      ["more", ["transcription"]],
    ]);
  });

  it("states what a task uses now: chosen, its own Auto, the deployment default, or nothing", () => {
    assert.equal(taskState(task("copy", { saved, deploymentDefault: "x/y" })), "chosen");
    assert.equal(taskState(task("direction_judge", { auto: "the copy model judges." })), "auto");
    assert.equal(taskState(task("copy", { deploymentDefault: "x/y" })), "default");
    assert.equal(taskState(task("vision", { needsImage: true })), "unset");
    assert.match(fallbackText(task("vision", { needsImage: true })), /nothing reads images/);
    assert.match(fallbackText(task("copy")), /nothing is sent/);
    assert.deepEqual(setupCounts([task("copy", { saved }), task("vision", { needsImage: true }), task("direction_judge", { auto: "a" })]), { chosen: 1, unset: 1, of: 3 });
  });

  it("offers one pick for several tasks only from the models every one of them can use", () => {
    const models = [model("a/text", "A: Text", ["copy", "research_analysis"]), model("b/vision", "B: Vision", ["copy", "research_analysis", "vision"])];
    assert.deepEqual(sharedModels(models, ["copy", "vision"]).map((item) => item.id), ["b/vision"]);
    assert.deepEqual(sharedModels(models, ["copy", "research_analysis"]).map((item) => item.id), ["a/text", "b/vision"]);
    assert.deepEqual(sharedModels(models, []), [], "nothing selected, nothing offered");
  });

  it("groups the picker by provider with the main providers first, and names models without the vendor prefix", () => {
    const groups = groupByProvider([
      model("qwen/q", "Qwen: Q", []),
      model("deepseek/d", "DeepSeek: D", []),
      model("anthropic/z", "Anthropic: Zeta", []),
      model("anthropic/a", "Anthropic: Alpha", []),
      model("openai/o", "OpenAI: O", []),
    ]);
    assert.deepEqual(groups.map((group) => group.label), ["Anthropic", "OpenAI", "DeepSeek", "Qwen"]);
    assert.deepEqual(groups[0]!.models.map((item) => item.id), ["anthropic/a", "anthropic/z"]);
    assert.equal(shortName({ id: "anthropic/a", name: "Anthropic: Claude Top" }), "Claude Top");
    assert.equal(shortName(null, "anthropic/claude-gone"), "claude-gone", "a saved model that left the catalogue still shows its id");
  });

  it("states prices as listed, never rounding a paid price to zero", () => {
    assert.equal(usd(0), "free");
    assert.equal(usd(0.018), "$0.018");
    assert.equal(usd(3), "$3.00");
    assert.equal(priceLine({ promptUsdPerMillionTokens: 0.1, completionUsdPerMillionTokens: 0.4 }), "$0.10 in · $0.40 out per M");
  });

  it("searches by plain words in the name or id, never by scattered letters", () => {
    assert.equal(matchesSearch("Gemini 3 Pro google/gemini-3-pro", "gemini"), 1);
    assert.equal(matchesSearch("GPT-5 Mini openai/gpt-5-mini", "gemini"), 0, "g-e-m-i-n-i scattered through the id is not a match");
    assert.equal(matchesSearch("Claude Top anthropic/claude-top", "anthropic  top"), 1, "each word, in any order");
    assert.equal(matchesSearch("Claude Top anthropic/claude-top", ""), 1, "an empty search shows everything");
  });

  it("reports a multi-task save with each refusal", () => {
    const ok = { task: "copy", label: "Copy", saved: true, reason: null };
    const no = { task: "vision", label: "Image understanding", saved: false, reason: "It takes no images. Nothing was saved." };
    assert.equal(bulkSummary([ok, { ...ok, task: "brain_suggest" }], "Claude Top").line, "Claude Top set for 2 tasks.");
    const mixed = bulkSummary([ok, no], "Claude Top");
    assert.equal(mixed.line, "Claude Top set for 1 of 2 tasks.");
    assert.deepEqual(mixed.refused, [no]);
    assert.match(bulkSummary([no], "Claude Top").line, /^Nothing changed/);
  });
});
