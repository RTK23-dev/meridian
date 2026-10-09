import assert from "node:assert/strict";
import test from "node:test";
import {
  getDefaultPipelineConfig,
  getPresetConfig,
  validatePipelineConfig,
  PIPELINE_PRESETS,
  DEFAULT_STAGES,
  type FactoryPipelineConfig,
} from "./pipeline-config.ts";

test("provides valid default pipeline configuration", () => {
  const config = getDefaultPipelineConfig();
  assert.equal(config.presetName, "viral_ugc");
  assert.equal(config.stages.length, 9);
  assert.equal(config.stages[0]?.id, "discover");
  assert.ok(config.stages.every((s) => typeof s.enabled === "boolean"));

  assert.ok(config.prompts.briefPrompt.includes("Meridian Creative Director"));
  assert.ok(config.prompts.scriptPrompt.includes("Hook (0-3s)"));
  assert.ok(config.prompts.gradingPrompt.includes("deterministic System One"));

  assert.equal(config.generationParams.videoCount, 3);
  assert.equal(config.generationParams.aspectRatio, "9:16");

  assert.equal(config.gradingThresholds.winnerScoreMin, 0.7);
  assert.equal(config.gradingThresholds.pBeatMin, 0.8);
  assert.equal(config.gradingThresholds.retention3sMin, 0.45);
});

test("exposes all 4 built-in presets with distinct characteristics", () => {
  assert.equal(PIPELINE_PRESETS.viral_ugc.generationParams.videoCount, 5);
  assert.equal(PIPELINE_PRESETS.viral_ugc.generationParams.renderPacing, "hyper_fast");

  assert.equal(PIPELINE_PRESETS.problem_solution.generationParams.videoCount, 3);
  assert.equal(PIPELINE_PRESETS.problem_solution.generationParams.aspectRatio, "9:16");

  assert.equal(PIPELINE_PRESETS.strict_quality.gradingThresholds.winnerScoreMin, 0.85);
  assert.equal(PIPELINE_PRESETS.strict_quality.gradingThresholds.strictClaimGate, true);
  assert.equal(PIPELINE_PRESETS.strict_quality.gradingThresholds.autoApproveEnabled, false);

  assert.equal(PIPELINE_PRESETS.manual_cloud.generationParams.provider, "manual_cloud");
  assert.equal(PIPELINE_PRESETS.manual_cloud.generationParams.videoCount, 3);
});

test("retrieves presets correctly by name", () => {
  const preset = getPresetConfig("strict_quality");
  assert.equal(preset.presetName, "strict_quality");
  assert.equal(preset.gradingThresholds.winnerScoreMin, 0.85);

  // Fallback for custom or unknown
  const fallback = getPresetConfig("custom");
  assert.equal(fallback.presetName, "viral_ugc");
});

test("validates and clamps boundary values safely", () => {
  const messyInput: Partial<FactoryPipelineConfig> = {
    presetName: "custom",
    generationParams: {
      videoCount: 99, // Should clamp to 10
      aspectRatio: "invalid_ratio" as any, // Should fallback to 9:16
      durationSeconds: 999, // Should clamp to 120
      dailyGenerationCap: -5, // Should clamp to 1
      provider: "hypit",
      renderPacing: "dynamic",
    },
    gradingThresholds: {
      winnerScoreMin: 1.5, // Should clamp to 0.99
      pBeatMin: 0.1, // Should clamp to 0.50
      retention3sMin: 0.05, // Should clamp to 0.10
      confidenceMin: 2.0, // Should clamp to 0.99
      autoApproveEnabled: true,
      strictClaimGate: false,
    },
    prompts: {
      briefPrompt: "A".repeat(5000), // Should clip to 4000
      scriptPrompt: "Short script",
      perceptionPrompt: "Perception",
      gradingPrompt: "Grading",
    },
  };

  const validated = validatePipelineConfig(messyInput);
  assert.equal(validated.generationParams.videoCount, 10);
  assert.equal(validated.generationParams.aspectRatio, "9:16");
  assert.equal(validated.generationParams.durationSeconds, 120);
  assert.equal(validated.generationParams.dailyGenerationCap, 1);

  assert.equal(validated.gradingThresholds.winnerScoreMin, 0.99);
  assert.equal(validated.gradingThresholds.pBeatMin, 0.5);
  assert.equal(validated.gradingThresholds.retention3sMin, 0.1);
  assert.equal(validated.gradingThresholds.confidenceMin, 0.99);

  assert.ok(validated.prompts.briefPrompt.length <= 4000);
});

test("preserves stage enable/disable toggles correctly", () => {
  const customStages = DEFAULT_STAGES.map((stage) =>
    stage.id === "launch" ? { ...stage, enabled: false } : stage,
  );
  const validated = validatePipelineConfig({
    stages: customStages,
  });

  const launchStage = validated.stages.find((s) => s.id === "launch");
  assert.equal(launchStage?.enabled, false);

  const discoverStage = validated.stages.find((s) => s.id === "discover");
  assert.equal(discoverStage?.enabled, true);
});
