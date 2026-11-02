import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeCutPacing,
  analyzeSpeechProsody,
} from "./perception-extensions.ts";

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
