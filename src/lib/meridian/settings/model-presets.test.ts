// Presets pick from the live catalogue: the flagship or the cheapest of a family's current generation, a second and a third family for
// the writer and the judge, never a variant (":free", ":batch") or an older model that only costs more, and Auto with the reason when a
// family is missing. The catalogue below has the shape of OpenRouter's listing: an older flagship still priced above its successors,
// batch variants, and dates.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CURRENT_GENERATION_SECONDS, imageCallFitsCeiling, presetChoices, type PresetCatalogueModel } from "./model-presets.ts";

const ALL = ["copy", "research_analysis", "brain_suggest", "direction_writer", "direction_judge"] as const;
const IMAGE = ["vision", "reference_analysis"] as const;
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;
const model = (id: string, out: number, created: string | null, vision = false): PresetCatalogueModel => ({
  id,
  name: id,
  promptUsdPerMillionTokens: out / 5,
  completionUsdPerMillionTokens: out,
  created: created === null ? null : day(created),
  suitsTasks: vision ? [...ALL, ...IMAGE] : [...ALL],
});
const CATALOGUE: PresetCatalogueModel[] = [
  model("anthropic/claude-opus-old", 75, "2025-08-05", true),
  model("anthropic/claude-haiku-old", 1.25, "2024-03-13", true),
  model("anthropic/claude-top", 50, "2026-09-01", true),
  model("anthropic/claude-mid", 10, "2026-09-28", true),
  model("anthropic/claude-small", 0.5, "2026-10-07", true),
  model("anthropic/claude-small:batch", 0.25, "2026-10-07", true),
  model("openai/gpt-flagship", 50, "2026-09-04", true),
  model("openai/gpt-small", 0.5, "2026-09-22", true),
  model("google/gemini-pro", 10, "2026-10-13", true),
  model("google/gemini-flash", 0.6, "2026-07-21", true),
  model("deepseek/deepseek-pro", 4.6, "2026-08-12"),
  model("deepseek/deepseek-flash", 0.18, "2026-04-24"),
  model("deepseek/deepseek-chat-old", 0.1, "2024-12-26"),
  model("deepseek/deepseek-flash:free", 0, "2026-10-01"),
];
const byTask = (choices: ReturnType<typeof presetChoices>) => Object.fromEntries(choices.map((choice) => [choice.task, choice.modelId]));

describe("model presets", () => {
  it("Claude only: the current flagship writes, the cheapest current Claude analyses, and the writer and judge stay on Auto", () => {
    assert.deepEqual(byTask(presetChoices("claude", CATALOGUE)), {
      copy: "anthropic/claude-top",
      research_analysis: "anthropic/claude-small",
      brain_suggest: "anthropic/claude-small",
      vision: "anthropic/claude-top",
      reference_analysis: "anthropic/claude-small",
      direction_writer: null,
      direction_judge: null,
    });
  });

  it("never picks an older model only because it costs more, nor an older one only because it costs less", () => {
    const choices = Object.values(byTask(presetChoices("claude", CATALOGUE)));
    assert.ok(!choices.includes("anthropic/claude-opus-old"), "an older flagship priced above its successor is not the flagship");
    assert.ok(!choices.includes("anthropic/claude-haiku-old"));
    assert.equal(byTask(presetChoices("budget", CATALOGUE)).research_analysis, "deepseek/deepseek-flash", "not the older, cheaper chat model");
  });

  it("never picks a variant: no :batch, no :free", () => {
    for (const preset of ["claude", "frontier", "budget"] as const) {
      for (const id of Object.values(byTask(presetChoices(preset, CATALOGUE)))) assert.ok(id === null || !id.includes(":"), `${preset} picked ${id}`);
    }
  });

  it("Frontier mix: three families for writer, second writer and judge, and DeepSeek for the bulk work", () => {
    const choices = byTask(presetChoices("frontier", CATALOGUE));
    assert.equal(choices.copy, "anthropic/claude-top");
    assert.equal(choices.direction_writer, "openai/gpt-flagship");
    assert.equal(choices.direction_judge, "google/gemini-pro");
    assert.equal(choices.research_analysis, "deepseek/deepseek-flash");
    assert.equal(choices.vision, "google/gemini-pro");
  });

  it("Budget: DeepSeek for text and a cheap current image reader for vision, with reasons that name the family picked", () => {
    const choices = presetChoices("budget", CATALOGUE);
    const ids = byTask(choices);
    assert.equal(ids.copy, "deepseek/deepseek-pro");
    assert.equal(ids.research_analysis, "deepseek/deepseek-flash");
    assert.equal(ids.vision, "google/gemini-flash", "DeepSeek reads no images here, so the next family's cheapest current reader");
    const noDeepSeek = presetChoices("budget", CATALOGUE.filter((entry) => !entry.id.startsWith("deepseek/")));
    const analysis = noDeepSeek.find((choice) => choice.task === "research_analysis")!;
    assert.equal(analysis.modelId, "google/gemini-flash");
    assert.match(analysis.reason, /no DeepSeek model suits it/);
  });

  it("takes an undated family as it is, and keeps a model dated within the window", () => {
    const undated = [model("deepseek/a", 1, null), model("deepseek/b", 0.2, null)];
    assert.equal(byTask(presetChoices("budget", undated)).research_analysis, "deepseek/b");
    const newest = day("2026-10-01");
    const edge = [model("deepseek/new", 1, "2026-10-01"), { ...model("deepseek/edge", 0.2, null), created: newest - CURRENT_GENERATION_SECONDS }];
    assert.equal(byTask(presetChoices("budget", edge)).research_analysis, "deepseek/edge");
    const past = [model("deepseek/new", 1, "2026-10-01"), { ...model("deepseek/past", 0.2, null), created: newest - CURRENT_GENERATION_SECONDS - 1 }];
    assert.equal(byTask(presetChoices("budget", past)).research_analysis, "deepseek/new");
  });

  it("leaves a task on Auto, with the reason, when the catalogue has no model for it", () => {
    const noClaude = CATALOGUE.filter((entry) => !entry.id.startsWith("anthropic/"));
    const copy = presetChoices("claude", noClaude).find((choice) => choice.task === "copy")!;
    assert.equal(copy.modelId, null);
    assert.match(copy.reason, /^Auto: the catalogue lists no Claude model/);
  });

  it("an image model fits a preset only when one image call's worst case is within the per-call ceiling", () => {
    // 200,000 tokens at $0.10 per million, plus 2,000 output tokens at $0.50 per million: $0.021.
    assert.equal(imageCallFitsCeiling({ promptUsdPerToken: 0.1e-6, completionUsdPerToken: 0.5e-6, contextLength: 200_000 }, 0.05), true);
    // 1,000,000 tokens at $2 per million: $2, refused on every image call at the default ceiling.
    assert.equal(imageCallFitsCeiling({ promptUsdPerToken: 2e-6, completionUsdPerToken: 10e-6, contextLength: 1_000_000 }, 0.05), false);
    assert.equal(imageCallFitsCeiling({ promptUsdPerToken: 0.1e-6, completionUsdPerToken: 0.5e-6, contextLength: null }, 0.05), false, "no stated context: no bound");
  });
});
