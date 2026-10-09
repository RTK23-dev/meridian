import assert from "node:assert/strict";
import test from "node:test";
import {
  validateReelsSafeZones,
  analyzeCutPacing,
  analyzeSpeechProsody,
} from "./perception-extensions.ts";

test("validateReelsSafeZones detects text clipping in Instagram overlay zones", () => {
  // Test case 1: Top header violation (y < 0.12)
  const topViolation = validateReelsSafeZones([
    {
      text: "Title in top header",
      box: { x: 0.2, y: 0.05, width: 0.5, height: 0.05 },
    },
  ]);
  assert.equal(topViolation.isSafe, false);
  assert.equal(topViolation.violations[0].zone, "top_header");

  // Test case 2: Bottom controls violation (y + height > 0.78)
  const bottomViolation = validateReelsSafeZones([
    {
      text: "Caption in bottom bar",
      box: { x: 0.2, y: 0.76, width: 0.5, height: 0.08 },
    },
  ]);
  assert.equal(bottomViolation.isSafe, false);
  assert.equal(bottomViolation.violations[0].zone, "bottom_controls");

  // Test case 3: Right rail violation (x + width > 0.86)
  const rightViolation = validateReelsSafeZones([
    {
      text: "Sticker in right buttons",
      box: { x: 0.82, y: 0.4, width: 0.15, height: 0.1 },
    },
  ]);
  assert.equal(rightViolation.isSafe, false);
  assert.equal(rightViolation.violations[0].zone, "right_action_rail");

  // Test case 4: Perfectly safe central placement
  const safeOverlay = validateReelsSafeZones([
    {
      text: "Centered punchline",
      box: { x: 0.2, y: 0.35, width: 0.6, height: 0.1 },
    },
  ]);
  assert.equal(safeOverlay.isSafe, true);
  assert.equal(safeOverlay.violations.length, 0);
});

test("analyzeCutPacing classifies hyper_fast vs cinematic pacing accurately", () => {
  // Hyper fast: 12 cuts in 15s = ~1.15s per shot
  const hyperCuts = [1.2, 2.3, 3.4, 4.8, 6.0, 7.1, 8.5, 9.9, 11.2, 12.4, 13.6, 14.8];
  const hyperAnalysis = analyzeCutPacing(hyperCuts, 15);
  assert.equal(hyperAnalysis.pacingCategory, "hyper_fast");
  assert.ok(hyperAnalysis.averageShotDurationSec < 1.5);

  // Cinematic slow: 2 cuts in 20s = 6.6s per shot
  const slowCuts = [7.0, 14.0];
  const slowAnalysis = analyzeCutPacing(slowCuts, 20);
  assert.equal(slowAnalysis.pacingCategory, "cinematic_slow");
  assert.ok(slowAnalysis.averageShotDurationSec >= 4.0);
});

test("analyzeSpeechProsody checks WPM against 140-180 sweet spot", () => {
  const words = [
    { word: "Stop", startSec: 0.1, endSec: 0.4 },
    { word: "making", startSec: 0.5, endSec: 0.8 },
    { word: "this", startSec: 0.9, endSec: 1.1 },
    { word: "mistake", startSec: 1.2, endSec: 1.6 },
    { word: "right", startSec: 1.7, endSec: 1.9 },
    { word: "now", startSec: 2.0, endSec: 2.3 },
  ];

  // 6 words in 2.3s ~ 156 WPM (inside sweet spot)
  const prosody = analyzeSpeechProsody(words, 2.3);
  assert.equal(prosody.isWithinSweetSpot, true);
  assert.ok(prosody.wordsPerMinute >= 140 && prosody.wordsPerMinute <= 180);
});
