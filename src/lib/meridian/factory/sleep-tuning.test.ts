import assert from "node:assert/strict";
import test from "node:test";
import { tunable } from "../../../engine/config/tunable.ts";
import { nightlyTuningOf, tuningSummaryOf, type TunedProposal } from "./sleep-tuning.ts";

// A tuned value at 0.6 with bounds 0.3 and 0.9. At the 15% cap it may move to 0.69 or 0.51, and no further.
const CRITIC = "thresholds.criticConfidence";
const critic = tunable(0.6, 0.3, 0.9);

function near(actual: number | null, expected: number): boolean {
  return actual !== null && Math.abs(actual - expected) < 1e-9;
}

test("a move inside the cap and the bounds is accepted in full", () => {
  const tuning = nightlyTuningOf([{ key: CRITIC, current: critic, proposed: 0.65 }]);
  assert.deepEqual(tuning.accepted, [{ key: CRITIC, from: 0.6, to: 0.65 }]);
  assert.deepEqual(tuning.refused, []);
  assert.equal(tuning.maxChangeShare, 0.15, "the cap is the engine's constant, 15%");
});

test("a move up beyond the cap is refused for the excess: the value is kept at the cap, and the reason is the cap", () => {
  const tuning = nightlyTuningOf([{ key: CRITIC, current: critic, proposed: 0.9 }]);
  assert.deepEqual(tuning.accepted, []);
  assert.equal(tuning.refused.length, 1);
  const [refusal] = tuning.refused;
  assert.equal(refusal?.key, CRITIC);
  assert.equal(refusal?.proposed, 0.9);
  assert.ok(near(refusal?.kept ?? null, 0.69), "kept at 15% above the current value");
  assert.ok(near(refusal?.excess ?? null, 0.21), "the refused excess is the part of the move beyond the cap");
  assert.equal(refusal?.reason, "it moves more than 15% from the current value");
});

test("a move down beyond the cap is refused the same way", () => {
  const tuning = nightlyTuningOf([{ key: CRITIC, current: critic, proposed: 0.3 }]);
  assert.deepEqual(tuning.accepted, []);
  const [refusal] = tuning.refused;
  assert.ok(near(refusal?.kept ?? null, 0.51), "kept at 15% below the current value");
  assert.ok(near(refusal?.excess ?? null, 0.21));
  assert.equal(refusal?.reason, "it moves more than 15% from the current value");
});

test("a move inside the cap but outside the ceiling is refused for the bound, and kept at the ceiling", () => {
  const near88 = tunable(0.88, 0.3, 0.9);
  // 0.95 is 0.07 from 0.88, inside the 15% cap of 0.132, and above the ceiling of 0.9.
  const tuning = nightlyTuningOf([{ key: CRITIC, current: near88, proposed: 0.95 }]);
  const [refusal] = tuning.refused;
  assert.equal(refusal?.kept, 0.9);
  assert.ok(near(refusal?.excess ?? null, 0.05));
  assert.equal(refusal?.reason, "it is outside the floor or ceiling");
});

test("a move beyond both the cap and the ceiling gives both reasons", () => {
  const tuning = nightlyTuningOf([{ key: CRITIC, current: critic, proposed: 1 }]);
  const [refusal] = tuning.refused;
  assert.equal(refusal?.kept, 0.69, "the cap stops the value before the ceiling does");
  assert.equal(refusal?.reason, "it moves more than 15% from the current value, and it is outside the floor or ceiling");
});

test("a proposal that is not a finite number keeps the current value, and is refused whole", () => {
  const tuning = nightlyTuningOf([{ key: CRITIC, current: critic, proposed: Number.NaN }]);
  assert.deepEqual(tuning.accepted, []);
  assert.deepEqual(tuning.refused, [
    { key: CRITIC, from: 0.6, proposed: null, kept: 0.6, excess: null, reason: "the proposal is not a finite number" },
  ]);
});

test("a proposal equal to the current value is neither accepted nor refused", () => {
  const tuning = nightlyTuningOf([{ key: CRITIC, current: critic, proposed: 0.6 }]);
  assert.deepEqual(tuning.accepted, []);
  assert.deepEqual(tuning.refused, []);
});

test("no proposal means nothing is accepted or refused, and the summary adds no line", () => {
  const tuning = nightlyTuningOf([]);
  assert.deepEqual(tuning, { maxChangeShare: 0.15, accepted: [], refused: [] });
  assert.equal(tuningSummaryOf(tuning), "");
});

test("the morning summary says what was accepted and what was refused, with the values and the reason", () => {
  const proposals: TunedProposal[] = [
    { key: CRITIC, current: critic, proposed: 0.9 },
    { key: "thresholds.other", current: critic, proposed: 0.62 },
  ];
  const summary = tuningSummaryOf(nightlyTuningOf(proposals));
  assert.equal(
    summary,
    "Tuning: 1 proposed change inside the 15% nightly cap, 1 refused. Refused thresholds.criticConfidence: proposed 0.9, kept 0.69, because it moves more than 15% from the current value.",
  );
});

test("the summary of a refusal with no finite value names it as no number", () => {
  const summary = tuningSummaryOf(nightlyTuningOf([{ key: CRITIC, current: critic, proposed: Number.NaN }]));
  assert.equal(
    summary,
    "Tuning: 0 proposed changes inside the 15% nightly cap, 1 refused. Refused thresholds.criticConfidence: proposed no number, kept 0.6, because the proposal is not a finite number.",
  );
});
