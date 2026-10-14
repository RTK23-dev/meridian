import assert from "node:assert/strict";
import test from "node:test";
import { thresholds } from "../config/thresholds.ts";
import { EngineError, type GateResult } from "../contracts/index.ts";
import {
  checkKey,
  decideGate,
  GOLD_LABEL_SCHEMA,
  GOLD_TARGETS,
  goldMetrics,
  goldMetricsForCheck,
  loadGoldLabelsJson,
  parseGoldLabels,
  type GoldLabel,
  type GoldOutcome,
} from "./gold.ts";

/** n outcomes of one kind: `caught` of the failing ones are predicted to fail, `falseFails` of the passing ones are. */
function outcomes(failing: number, caught: number, passing: number, falseFails: number): GoldOutcome[] {
  const list: GoldOutcome[] = [];
  for (let index = 0; index < failing; index++) {
    list.push({ shouldFail: true, predictedFail: index < caught });
  }
  for (let index = 0; index < passing; index++) {
    list.push({ shouldFail: false, predictedFail: index < falseFails });
  }
  return list;
}

test("the targets are read from config: 200 labels to start, recall 0.90, false-fail 0.10", () => {
  assert.equal(GOLD_TARGETS.examplesToStart, thresholds.goldSets.examplesToStart);
  assert.equal(GOLD_TARGETS.examplesToStart, 200);
  assert.equal(GOLD_TARGETS.recallMin, thresholds.goldSets.recallTargetOnFailures);
  assert.equal(GOLD_TARGETS.recallMin, 0.9);
  assert.equal(GOLD_TARGETS.falseFailMax, thresholds.goldSets.falseFailMax);
  assert.equal(GOLD_TARGETS.falseFailMax, 0.1);
  assert.equal(GOLD_TARGETS.perClassToStart, 100);
});

test("a check blocks only at exactly the targets: recall 0.90 and false-fail 0.10 on 200 labels", () => {
  const metrics = goldMetrics(outcomes(100, 90, 100, 10));
  assert.equal(metrics.total, 200);
  assert.equal(metrics.recall, 0.9);
  assert.equal(metrics.falseFailRate, 0.1);
  assert.equal(metrics.enoughLabels, true);
  assert.equal(metrics.meetsTarget, true);
});

test("recall just under the target does not block", () => {
  const metrics = goldMetrics(outcomes(100, 89, 100, 0));
  assert.equal(metrics.recall, 0.89);
  assert.equal(metrics.meetsTarget, false);
});

test("a false-fail rate just over the limit does not block", () => {
  const metrics = goldMetrics(outcomes(100, 100, 100, 11));
  assert.equal(metrics.falseFailRate, 0.11);
  assert.equal(metrics.meetsTarget, false);
});

test("fewer than 200 labels never block, even with perfect accuracy", () => {
  const metrics = goldMetrics(outcomes(100, 100, 99, 0));
  assert.equal(metrics.total, 199);
  assert.equal(metrics.recall, 1);
  assert.equal(metrics.falseFailRate, 0);
  assert.equal(metrics.enoughLabels, false);
  assert.equal(metrics.meetsTarget, false);
});

test("200 labels with too few failing examples never block: the sample is one-sided", () => {
  const metrics = goldMetrics(outcomes(50, 50, 150, 0));
  assert.equal(metrics.total, 200);
  assert.equal(metrics.enoughLabels, false);
  assert.equal(metrics.meetsTarget, false);
});

test("with no failing labels or no passing labels, the rate is unknown and the check does not block", () => {
  assert.equal(goldMetrics(outcomes(0, 0, 200, 0)).recall, null);
  assert.equal(goldMetrics(outcomes(0, 0, 200, 0)).meetsTarget, false);
  assert.equal(goldMetrics(outcomes(200, 200, 0, 0)).falseFailRate, null);
  assert.equal(goldMetrics(outcomes(200, 200, 0, 0)).meetsTarget, false);
  assert.equal(goldMetrics([]).meetsTarget, false);
});

const LABEL_BASE = {
  schema: GOLD_LABEL_SCHEMA,
  subjectId: "plan_fixture_1",
  source: "owner_seed",
  reason: "owner-labelled",
  input: { shots: [] },
} as const;

function label(labelId: string, extra: Partial<GoldLabel> = {}): GoldLabel {
  return { ...LABEL_BASE, labelId, check: "plan:shots_tile_voice_duration", shouldFail: false, ...extra } as GoldLabel;
}

test("a gold set parses to typed labels, and a bad label is refused with a typed error", () => {
  const parsed = parseGoldLabels([label("gl_1"), label("gl_2", { shouldFail: true })]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].shouldFail, true);

  assert.throws(
    () => parseGoldLabels([label("gl_1", { check: "no-colon-here" })]),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input" && /gold label 0/.test(error.message),
  );
  assert.throws(() => parseGoldLabels([label("gl_1"), label("gl_1")]), (error: unknown) => error instanceof EngineError && /repeats/.test(error.message));
  assert.throws(() => parseGoldLabels({ labels: [] }), (error: unknown) => error instanceof EngineError);
  assert.throws(() => parseGoldLabels([label("gl_1", { source: "guess" as "owner_seed" })]), (error: unknown) => error instanceof EngineError);
});

test("a gold set file that is not JSON is a typed error, never an empty set", () => {
  assert.throws(
    () => loadGoldLabelsJson("[{ not json"),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input" && error.cause !== undefined,
  );
  assert.deepEqual(loadGoldLabelsJson("[]"), []);
  assert.equal(loadGoldLabelsJson(JSON.stringify([label("gl_1")]))[0].labelId, "gl_1");
});

test("the metrics of one check use only its own labels, run through the caller's predictor", () => {
  const labels = [
    label("gl_1", { check: "plan:shots_tile_voice_duration", shouldFail: true }),
    label("gl_2", { check: "plan:must_satisfied", shouldFail: true }),
  ];
  const metrics = goldMetricsForCheck(labels, "plan:shots_tile_voice_duration", () => true);
  assert.equal(metrics.total, 1);
  assert.equal(metrics.caughtFailures, 1);
});

function resultOf(gate: "plan", failing: string[]): GateResult {
  const checks = [
    { rule: "shots_tile_voice_duration", pass: !failing.includes("shots_tile_voice_duration") },
    { rule: "must_satisfied", pass: !failing.includes("must_satisfied") },
  ];
  return { gate, subjectId: "plan_x", pass: checks.every((item) => item.pass), checks };
}

const provenMetrics = goldMetrics(outcomes(100, 90, 100, 10));
const unprovenMetrics = goldMetrics(outcomes(10, 10, 10, 0));

test("a passing gate proceeds, whatever the gold sets say", () => {
  const decision = decideGate(resultOf("plan", []), {});
  assert.equal(decision.verdict, "pass");
});

test("a failing check with no gold set routes to review, never to block", () => {
  const decision = decideGate(resultOf("plan", ["must_satisfied"]), {});
  assert.equal(decision.verdict, "review");
  assert.deepEqual(decision.unprovenFailures, [checkKey("plan", "must_satisfied")]);
});

test("a failing check whose gold set does not meet the target routes to review", () => {
  const decision = decideGate(resultOf("plan", ["must_satisfied"]), { [checkKey("plan", "must_satisfied")]: unprovenMetrics });
  assert.equal(decision.verdict, "review");
});

test("a failing check whose gold set meets the target blocks", () => {
  const decision = decideGate(resultOf("plan", ["must_satisfied"]), { [checkKey("plan", "must_satisfied")]: provenMetrics });
  assert.equal(decision.verdict, "block");
  assert.deepEqual(decision.provenFailures, ["plan:must_satisfied"]);
});

test("one proven failure blocks even when another failing check is unproven; the unproven one is still listed", () => {
  const decision = decideGate(resultOf("plan", ["must_satisfied", "shots_tile_voice_duration"]), {
    "plan:must_satisfied": provenMetrics,
  });
  assert.equal(decision.verdict, "block");
  assert.deepEqual(decision.provenFailures, ["plan:must_satisfied"]);
  assert.deepEqual(decision.unprovenFailures, ["plan:shots_tile_voice_duration"]);
});

test("the check key is gate:rule", () => {
  assert.equal(checkKey("plan", "must_satisfied"), "plan:must_satisfied");
});
