import assert from "node:assert/strict";
import test from "node:test";
import {
  SlopAndCraftGateEvaluator,
  type ShotQualityMetrics,
  type CompositionCraftMetrics,
} from "./slop-craft-gates.ts";

test("SlopAndCraftGateEvaluator blocks morphing faces and garbled video text", () => {
  const sloppyShots: ShotQualityMetrics[] = [
    {
      shotIndex: 0,
      sourceRank: 4,
      hasFaceMorphingArtifacts: true,
      hasGarbledVideoText: false,
      temporalFlickerScore: 0.2,
      hasPlasticSkinBlur: true,
    },
    {
      shotIndex: 1,
      sourceRank: 4,
      hasFaceMorphingArtifacts: false,
      hasGarbledVideoText: true,
      temporalFlickerScore: 0.1,
      hasPlasticSkinBlur: false,
    },
  ];

  const craftMetrics: CompositionCraftMetrics = {
    firstFrameHasVisualInterest: true,
    measuredLufs: -14.0,
    textOverlays: [{ text: "Safe Title", box: { x: 0.2, y: 0.3, width: 0.5, height: 0.1 } }],
    voiceIsMonotoneRobot: false,
  };

  const result = SlopAndCraftGateEvaluator.evaluate(sloppyShots, craftMetrics);
  assert.equal(result.passed, false);
  assert.ok(result.failedGates.some((g) => g.includes("facial morphing")));
  assert.ok(result.failedGates.some((g) => g.includes("garbled AI text")));
});

test("SlopAndCraftGateEvaluator blocks safe zone violations, poor loudness, and flat TTS", () => {
  const cleanShots: ShotQualityMetrics[] = [
    {
      shotIndex: 0,
      sourceRank: 1,
      hasFaceMorphingArtifacts: false,
      hasGarbledVideoText: false,
      temporalFlickerScore: 0.1,
      hasPlasticSkinBlur: false,
    },
  ];

  const poorCraft: CompositionCraftMetrics = {
    firstFrameHasVisualInterest: false,
    measuredLufs: -24.0, // Too quiet
    textOverlays: [
      { text: "Clipped Top", box: { x: 0.2, y: 0.02, width: 0.6, height: 0.1 } }, // top header violation
    ],
    voiceIsMonotoneRobot: true,
  };

  const result = SlopAndCraftGateEvaluator.evaluate(cleanShots, poorCraft);
  assert.equal(result.passed, false);
  assert.ok(result.failedGates.some((g) => g.includes("lacks visual pattern interrupt")));
  assert.ok(result.failedGates.some((g) => g.includes("clips Instagram top_header")));
  assert.ok(result.failedGates.some((g) => g.includes("Loudness -24 LUFS outside")));
  assert.ok(result.failedGates.some((g) => g.includes("monotone robot TTS")));
});

test("SlopAndCraftGateEvaluator passes clean creator-grade compositions", () => {
  const cleanShots: ShotQualityMetrics[] = [
    {
      shotIndex: 0,
      sourceRank: 1,
      hasFaceMorphingArtifacts: false,
      hasGarbledVideoText: false,
      temporalFlickerScore: 0.1,
      hasPlasticSkinBlur: false,
    },
  ];

  const goodCraft: CompositionCraftMetrics = {
    firstFrameHasVisualInterest: true,
    measuredLufs: -14.2,
    textOverlays: [
      { text: "Centered Punchline", box: { x: 0.2, y: 0.35, width: 0.6, height: 0.1 } },
    ],
    voiceIsMonotoneRobot: false,
  };

  const result = SlopAndCraftGateEvaluator.evaluate(cleanShots, goodCraft);
  assert.equal(result.passed, true);
  assert.equal(result.failedGates.length, 0);
});
