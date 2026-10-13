import assert from "node:assert/strict";
import test from "node:test";
import { predictionFingerprint, type GradeRecord } from "../factory/prediction.ts";
import {
  buildQuestionOutcomes,
  isSimulated,
  medianOf,
  outcomeValueOf,
  questionKeyOf,
  type OutcomeAnswer,
  type OutcomeCreative,
  type OutcomeInputs,
  type OutcomePick,
  type OutcomeTelemetryRow,
} from "./question-outcomes.ts";

const QUESTION = "market.competitive_strength.v1";
const VERSION = "1.0.0";
const KEY = questionKeyOf(QUESTION, VERSION);

const GRADE: GradeRecord = {
  jev_status: "engine",
  jev_action: "HUMAN_REVIEW",
  jev_reason: "graded",
  jev_engine_id: "jev",
  jev_model: "fixture-model",
  jev_question_versions: `["${QUESTION}@${VERSION}"]`,
  jev_policy_version: `${QUESTION}@${VERSION}`,
  jev_gate_record_id: "gate-1",
};
const FINGERPRINT = predictionFingerprint(GRADE);

/** A pick whose grade is the one it was made under, with one answer for the question, and whose creative is `cr-<id>`. */
function pick(id: string, overrides: Partial<OutcomePick> = {}): OutcomePick {
  return {
    pickId: id,
    surface: "paid",
    storedFingerprint: FINGERPRINT,
    grade: GRADE,
    gateAnswers: [{ runId: `run-${id}`, questionId: QUESTION }],
    templateId: `tpl:${id}`,
    ...overrides,
  };
}

function creativeOf(id: string): OutcomeCreative {
  return { templateId: `tpl:${id}`, creativeId: `cr-${id}` };
}

function answer(id: string, probability: number | null, overrides: Partial<OutcomeAnswer> = {}): OutcomeAnswer {
  return { runId: `run-${id}`, questionId: QUESTION, questionVersion: VERSION, probability, status: "answered", ...overrides };
}

/** A paid row: clicks out of impressions. Null clicks or impressions is a metric the source did not report. */
function paid(creativeId: string, clicks: number | null, impressions: number | null, metadata: unknown = {}): OutcomeTelemetryRow {
  return { creativeId, surface: "paid", clicks, impressions, completionRate: null, metadata };
}

function organic(creativeId: string, completionRate: number | null): OutcomeTelemetryRow {
  return { creativeId, surface: "organic", clicks: null, impressions: null, completionRate, metadata: {} };
}

/** Two other paid creatives, so the paid surface has a baseline. Their CTRs are 0.09 and 0.10, so the median is 0.09. */
const BASELINE_ROWS: OutcomeTelemetryRow[] = [paid("b", 9, 100), paid("c", 10, 100)];

function inputs(overrides: Partial<OutcomeInputs> = {}): OutcomeInputs {
  return {
    picks: [pick("p")],
    creatives: [creativeOf("p")],
    telemetry: [paid("p", 5, 100), ...BASELINE_ROWS],
    answers: [answer("p", 0.97)],
    ...overrides,
  };
}

test("a pick is one observation: its stated probability, and whether its creative beat the brand's median on its surface", () => {
  // The pick's creative has a CTR of 0.05, below the 0.09 median, so the observation is a failure.
  const build = buildQuestionOutcomes(inputs());
  assert.equal(build.baselines.paid, 0.09);
  assert.deepEqual(build.questions.get(KEY)?.observations, [{ predicted: 0.97, success: false }]);

  const winning = buildQuestionOutcomes(inputs({ telemetry: [paid("p", 15, 100), ...BASELINE_ROWS] }));
  assert.deepEqual(winning.questions.get(KEY)?.observations, [{ predicted: 0.97, success: true }]);
});

test("an organic pick is judged by completion rate against the organic median", () => {
  const build = buildQuestionOutcomes(inputs({
    picks: [pick("o", { surface: "organic" })],
    creatives: [creativeOf("o")],
    telemetry: [organic("o", 0.6), organic("x", 0.2), organic("y", 0.4)],
    answers: [answer("o", 0.8)],
  }));
  assert.equal(build.baselines.organic, 0.4);
  assert.deepEqual(build.questions.get(KEY)?.observations, [{ predicted: 0.8, success: true }]);
});

test("an unreported metric is never counted: the newest row that reports the metric is the outcome", () => {
  // The newest row has no impressions, so it reports no CTR. The older row, which reports one, is the outcome.
  const build = buildQuestionOutcomes(inputs({
    telemetry: [paid("p", null, null), paid("p", 15, 100), ...BASELINE_ROWS],
  }));
  assert.deepEqual(build.questions.get(KEY)?.observations, [{ predicted: 0.97, success: true }]);
});

test("a creative whose only row reports no metric has no outcome, and its pick is not an observation", () => {
  const build = buildQuestionOutcomes(inputs({ telemetry: [paid("p", null, 100), ...BASELINE_ROWS] }));
  assert.equal(build.questions.get(KEY), undefined);
  assert.equal(build.excluded.no_outcome, 1);
});

test("impressions of zero give no click-through rate, so the row is not an outcome", () => {
  assert.equal(outcomeValueOf(paid("p", 0, 0), "paid"), null);
  assert.equal(outcomeValueOf(paid("p", 3, 60), "paid"), 0.05);
});

test("a synthetic or simulated row is never an outcome, and never sets a baseline", () => {
  const build = buildQuestionOutcomes(inputs({
    telemetry: [
      paid("p", 90, 100, { synthetic: true }),
      paid("p", 5, 100),
      paid("z", 99, 100, { simulated: true }),
      ...BASELINE_ROWS,
    ],
  }));
  assert.equal(build.baselines.paid, 0.09, "the simulated 0.99 is not one of the brand's creatives");
  assert.deepEqual(build.questions.get(KEY)?.observations, [{ predicted: 0.97, success: false }], "the synthetic 0.9 is not the outcome");
});

test("isSimulated reads the flags in a row's metadata, as an object or as JSON text", () => {
  assert.equal(isSimulated({ synthetic: true }), true);
  assert.equal(isSimulated({ simulated: true }), true);
  assert.equal(isSimulated('{"synthetic":true}'), true);
  assert.equal(isSimulated({ synthetic: "true" }), false, "only the boolean flag counts");
  assert.equal(isSimulated({}), false);
  assert.equal(isSimulated("not json"), false);
});

test("a surface with fewer than two measured creatives has no baseline, so its picks are not observations", () => {
  const build = buildQuestionOutcomes(inputs({ telemetry: [paid("p", 5, 100)] }));
  assert.equal(build.baselines.paid, null);
  assert.equal(build.questions.get(KEY), undefined);
  assert.equal(build.excluded.no_baseline, 1);
});

test("a regraded pick, and a pick written before fingerprints, are not observations: their prediction is not known", () => {
  const build = buildQuestionOutcomes(inputs({
    picks: [
      pick("regraded", { storedFingerprint: "engine:some-earlier-grade", templateId: "tpl:regraded" }),
      pick("unrecorded", { storedFingerprint: "", templateId: "tpl:unrecorded" }),
    ],
    creatives: [creativeOf("regraded"), creativeOf("unrecorded")],
    telemetry: [paid("regraded", 5, 100), paid("unrecorded", 5, 100), ...BASELINE_ROWS],
    answers: [answer("regraded", 0.97), answer("unrecorded", 0.97)],
  }));
  assert.equal(build.questions.get(KEY), undefined);
  assert.equal(build.excluded.regraded, 1);
  assert.equal(build.excluded.unrecorded_grade, 1);
});

test("a pick with no surface, or with no control creative, is not an observation", () => {
  const build = buildQuestionOutcomes(inputs({
    picks: [pick("nosurface", { surface: "" }), pick("nocreative", { templateId: "tpl:none" })],
    creatives: [creativeOf("nosurface")],
    telemetry: [paid("nosurface", 5, 100), ...BASELINE_ROWS],
    answers: [answer("nosurface", 0.97), answer("nocreative", 0.97)],
  }));
  assert.equal(build.questions.get(KEY), undefined);
  assert.equal(build.excluded.no_surface, 1);
  assert.equal(build.excluded.no_creative, 1);
});

test("only an answered question with a probability is an observation", () => {
  const build = buildQuestionOutcomes(inputs({
    answers: [answer("p", null), answer("p", 0.97, { status: "abstain_insufficient_evidence" })],
  }));
  assert.equal(build.questions.get(KEY), undefined);
});

test("the question version is part of the key, and each version has its own observations", () => {
  const build = buildQuestionOutcomes(inputs({
    picks: [pick("p"), pick("q", { templateId: "tpl:q" })],
    creatives: [creativeOf("p"), creativeOf("q")],
    telemetry: [paid("p", 5, 100), paid("q", 5, 100), ...BASELINE_ROWS],
    answers: [answer("p", 0.97), answer("q", 0.4, { questionVersion: "2.0.0" })],
  }));
  assert.deepEqual(build.questions.get(KEY)?.observations, [{ predicted: 0.97, success: false }]);
  assert.deepEqual(build.questions.get(questionKeyOf(QUESTION, "2.0.0"))?.observations, [{ predicted: 0.4, success: false }]);
});

test("the observations are the same whatever order the rows arrive in", () => {
  const second: OutcomePick = pick("q", { templateId: "tpl:q" });
  const rows: OutcomeInputs = inputs({
    picks: [pick("p"), second],
    creatives: [creativeOf("p"), creativeOf("q")],
    telemetry: [paid("p", 5, 100), paid("q", 15, 100), ...BASELINE_ROWS],
    answers: [answer("p", 0.97), answer("q", 0.6)],
  });
  const forward = buildQuestionOutcomes(rows);
  const reversed = buildQuestionOutcomes({
    ...rows,
    picks: [...rows.picks].reverse(),
    telemetry: [...rows.telemetry].reverse(),
    answers: [...rows.answers].reverse(),
  });
  assert.deepEqual(reversed.questions.get(KEY), forward.questions.get(KEY));
  assert.deepEqual(reversed.baselines, forward.baselines);
});

test("the median is the middle value, or the mean of the two middle values", () => {
  assert.equal(medianOf([]), null);
  assert.equal(medianOf([3, 1, 2]), 2);
  assert.equal(medianOf([4, 1, 3, 2]), 2.5);
});
