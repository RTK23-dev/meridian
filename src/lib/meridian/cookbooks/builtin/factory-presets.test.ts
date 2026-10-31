// The factory presets and the start modes as cookbooks (K5): each preset, resolved through its cookbook with its own numbers, gives back
// the configuration getPresetConfig gives today; a change to a control reaches the configuration; the blank cookbooks are valid.

import assert from "node:assert/strict";
import { test } from "node:test";
import { getPresetConfig } from "../../factory/pipeline-config.ts";
import { resolveCookbook, type ResolvedCookbook } from "../resolve.ts";
import { validateCookbook } from "../validate.ts";
import { blankCookbook, FACTORY_PRESET_NAMES, factoryPresetCookbook, pipelineConfigFromCookbook } from "./factory-presets.ts";

function resolved(cookbook: ReturnType<typeof factoryPresetCookbook>, values: Record<string, string | number | boolean> = {}): ResolvedCookbook {
  const result = resolveCookbook(cookbook, { values, lengthMs: 30000 });
  assert.equal(result.ok, true, result.ok ? "" : result.issues.join("; "));
  if (!result.ok) throw new Error("unreachable");
  return result.resolved;
}

for (const name of FACTORY_PRESET_NAMES) {
  test(`the ${name} preset, resolved through its cookbook, gives the configuration getPresetConfig gives`, () => {
    const cookbook = factoryPresetCookbook(name);
    assert.equal(validateCookbook(cookbook).ok, true, name);
    const config = pipelineConfigFromCookbook(resolved(cookbook), name);
    assert.deepEqual(config, getPresetConfig(name));
  });

  test(`the ${name} prompts are bounded instructions, one per role`, () => {
    const cookbook = factoryPresetCookbook(name);
    assert.equal(cookbook.instructions.length, 4);
    for (const instruction of cookbook.instructions) assert.ok(instruction.text.length <= 4000, `${name} ${instruction.role}`);
  });
}

test("a stage toggle reaches the configuration's stage, and no other stage moves", () => {
  const config = pipelineConfigFromCookbook(resolved(factoryPresetCookbook("viral_ugc"), { stage_launch: false }), "viral_ugc");
  const launch = config.stages.find((stage) => stage.id === "launch");
  assert.equal(launch?.enabled, false);
  assert.equal(config.stages.filter((stage) => stage.enabled).length, config.stages.length - 1);
});

test("the generation and grading controls reach the configuration", () => {
  const config = pipelineConfigFromCookbook(
    resolved(factoryPresetCookbook("manual_cloud"), { video_count: 7, duration_seconds: "45", winner_score_min: 0.8, auto_approve: true }),
    "manual_cloud",
  );
  assert.equal(config.generationParams.videoCount, 7);
  assert.equal(config.generationParams.durationSeconds, 45);
  assert.equal(config.gradingThresholds.winnerScoreMin, 0.8);
  assert.equal(config.gradingThresholds.autoApproveEnabled, true);
});

test("a factory preset runs in engine mode only, since it is the factory's own pipeline", () => {
  const plain = resolved(factoryPresetCookbook("problem_solution"));
  assert.deepEqual(plain.modes, ["engine"]);
});

test("the three start modes are valid blank cookbooks", () => {
  for (const mode of ["brief", "reference", "studio"] as const) {
    const cookbook = blankCookbook(mode);
    assert.equal(validateCookbook(cookbook).ok, true, mode);
    assert.deepEqual(resolved(cookbook).modes, ["engine"]);
  }
});
