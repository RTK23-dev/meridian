import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RUN_SETTINGS,
  MASTER_COST_FLOOR_SENTENCE,
  MASTER_COST_FLOOR_USD,
  automationFromBrainLevel,
  automationFromFactoryLevel,
  automationFromStudioAutonomy,
  costPerMasterProblem,
  mergeRunSettings,
  parseRunSettings,
  parseStoredSettings,
  runCostProblem,
  runSettingsFromStorage,
} from "./run-settings.ts";

test("run settings accept a partial override and lay it over the defaults", () => {
  const parsed = parseRunSettings({ automation: "semi", formats: ["video", "image", "video"], platforms: ["instagram", "tiktok"] });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.automation, "semi");
  assert.deepEqual(parsed.value.formats, ["video", "image"], "duplicate formats are collapsed");
  assert.deepEqual(parsed.value.platforms, ["instagram", "tiktok"]);
  assert.equal(parsed.value.intent, DEFAULT_RUN_SETTINGS.intent, "a key that is not given keeps its default");
});

test("run settings refuse an unknown value with the reason, and never coerce it", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ automation: "autonomous" }, /Automation must be one of manual, semi, full/],
    [{ intent: "viral" }, /Intent must be one of/],
    [{ formats: [] }, /at least one format/],
    [{ formats: ["audio"] }, /Formats must be/],
    [{ platforms: ["Instagram"] }, /platform id/],
    [{ providers: { video: "BAD ID" } }, /provider must be auto or a provider id/],
    [{ providers: { audio: "auto" } }, /can only be set for/],
    [{ caps: { dailyCents: -1 } }, /daily cap must be a whole number/],
    [{ caps: { totalCents: 1.5 } }, /total cap must be a whole number/],
    [{ caps: { maxVariants: 0 } }, /Max variants per run/],
  ];
  for (const [input, message] of cases) {
    const parsed = parseRunSettings(input);
    assert.equal(parsed.ok, false, `refused: ${JSON.stringify(input)}`);
    if (!parsed.ok) assert.match(parsed.error, message);
  }
});

test("run settings refuse something that is not an object", () => {
  const parsed = parseRunSettings("full");
  assert.equal(parsed.ok, false);
});

test("the run's own override beats the brand default, which beats the built-in default", () => {
  const brand = { automation: "semi" as const, caps: { dailyCents: 500, totalCents: 5000, maxVariants: 8 } };
  const run = { automation: "full" as const, caps: { dailyCents: 0, totalCents: 1000, maxVariants: 8 } };
  const effective = mergeRunSettings(brand, run);
  assert.equal(effective.automation, "full");
  assert.equal(effective.caps.totalCents, 1000);
  assert.equal(effective.caps.dailyCents, 0, "the run's zero replaces the brand's daily cap, so the run has no daily cap");
  assert.equal(effective.intent, DEFAULT_RUN_SETTINGS.intent);
  assert.equal(mergeRunSettings(null, null).automation, "manual", "with no defaults at all, a run is manual");
});

test("old automation vocabularies map onto the one model", () => {
  assert.equal(automationFromFactoryLevel(0), "manual");
  assert.equal(automationFromFactoryLevel(1), "manual");
  assert.equal(automationFromFactoryLevel(2), "semi");
  assert.equal(automationFromFactoryLevel(3), "full");

  assert.equal(automationFromStudioAutonomy("manual"), "manual");
  assert.equal(automationFromStudioAutonomy("semi_automatic"), "semi");
  assert.equal(automationFromStudioAutonomy("fully_automatic"), "full");

  assert.equal(automationFromBrainLevel("manual"), "manual");
  assert.equal(automationFromBrainLevel("assisted"), "manual");
  assert.equal(automationFromBrainLevel("automated"), "semi");
  assert.equal(automationFromBrainLevel("autonomous"), "full");
});

test("the cost per master is unset by default, and a parsed setting with no cost reads as null", () => {
  assert.equal(DEFAULT_RUN_SETTINGS.costPerMasterUsd, null);
  const parsed = parseRunSettings({ automation: "semi" });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.costPerMasterUsd, null);
});

test("a cost per master is a finite USD amount with at most 2 decimals, and never below the floor", () => {
  assert.equal(costPerMasterProblem(null), null, "not set is allowed");
  assert.equal(costPerMasterProblem(MASTER_COST_FLOOR_USD), null, "at the floor is allowed");
  assert.equal(costPerMasterProblem(0.75), null);
  assert.equal(costPerMasterProblem(120), null);
  assert.match(costPerMasterProblem(0.51) ?? "", /below the floor/);
  assert.match(costPerMasterProblem(0) ?? "", /below the floor/);
  assert.match(costPerMasterProblem(-1) ?? "", /dollar amount/);
  assert.match(costPerMasterProblem(0.755) ?? "", /at most 2 decimals/);
  assert.match(costPerMasterProblem(NaN) ?? "", /dollar amount/);
  assert.match(costPerMasterProblem(Infinity) ?? "", /dollar amount/);
  assert.match(costPerMasterProblem("0.75") ?? "", /dollar amount/, "a string is not a stored amount");
});

test("the floor is the engine's fixed per-master cost, and the sentence names it", () => {
  assert.equal(MASTER_COST_FLOOR_USD, 0.52);
  assert.equal(MASTER_COST_FLOOR_SENTENCE, "Every master costs at least $0.52: the fixed Claude, critic, render and media cost.");
});

test("settings parsed with a cost per master keep it, and a refused cost refuses the whole settings object", () => {
  const kept = parseRunSettings({ costPerMasterUsd: 0.75 });
  assert.equal(kept.ok && kept.value.costPerMasterUsd, 0.75);
  const cleared = parseRunSettings({ costPerMasterUsd: null }, { ...DEFAULT_RUN_SETTINGS, costPerMasterUsd: 0.75 });
  assert.equal(cleared.ok && cleared.value.costPerMasterUsd, null, "an explicit null clears the base cost");
  const refused = parseRunSettings({ costPerMasterUsd: 0.755 });
  assert.equal(refused.ok, false, "a cost that is not a 2-decimal dollar amount refuses the settings");
});

test("a stored cost below the floor still parses, keeps the caps, and the run is refused at start", () => {
  const stored = JSON.stringify({ formats: ["video"], caps: { dailyCents: 500, totalCents: 0, maxVariants: 8 }, costPerMasterUsd: 0.3 });
  const parsed = parseStoredSettings(stored);
  assert.ok(parsed, "a floor that rose later never makes saved settings unreadable");
  assert.equal(parsed?.caps.dailyCents, 500, "the caps are kept");
  assert.equal(parsed?.costPerMasterUsd, 0.3);
  assert.match(runCostProblem({ formats: ["video"], costPerMasterUsd: 0.3 }) ?? "", /below the floor/);
});

test("old saved settings with no cost per master read as null, never as a number", () => {
  const legacy = JSON.stringify({ automation: "semi", formats: ["video"], caps: { dailyCents: 500, totalCents: 0, maxVariants: 8 } });
  const parsed = parseStoredSettings(legacy);
  assert.ok(parsed, "the stored settings still parse");
  assert.equal(parsed?.costPerMasterUsd, null);
  assert.equal(runSettingsFromStorage(legacy, 2).costPerMasterUsd, null);
  assert.equal(runSettingsFromStorage(null, 3).costPerMasterUsd, null, "a run from before settings is read from its level");
  assert.equal(mergeRunSettings({ automation: "semi" }, null).costPerMasterUsd, null);
});

test("a saved cost per master round-trips through storage", () => {
  const stored = JSON.stringify({ ...DEFAULT_RUN_SETTINGS, costPerMasterUsd: 1.25 });
  assert.equal(parseStoredSettings(stored)?.costPerMasterUsd, 1.25);
});

test("a run that makes video needs a cost per master, and an image-only run does not", () => {
  assert.equal(runCostProblem({ formats: ["video"], costPerMasterUsd: null }), `Type the cost per master (USD). ${MASTER_COST_FLOOR_SENTENCE}`);
  assert.match(runCostProblem({ formats: ["image", "video"], costPerMasterUsd: null }) ?? "", /Type the cost per master/, "a mixed run with video needs one too");
  assert.equal(runCostProblem({ formats: ["image"], costPerMasterUsd: null }), null);
  assert.equal(runCostProblem({ formats: ["carousel"], costPerMasterUsd: null }), null);
  assert.equal(runCostProblem({ formats: ["video"], costPerMasterUsd: MASTER_COST_FLOOR_USD }), null);
  assert.match(runCostProblem({ formats: ["video"], costPerMasterUsd: 0.1 }) ?? "", /below the floor/);
});
