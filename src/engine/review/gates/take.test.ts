import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { thresholds } from "../../config/thresholds.ts";
import { EngineError } from "../../contracts/errors.ts";
import { takeVerdictSchema, type TakeVerdict } from "../../contracts/take.ts";
import { gateResultSchema } from "../../contracts/gate.ts";
import { NOT_CONNECTED_REASON } from "../take/similarity.ts";
import type { SimilarityOutcome, TakeGoldMetrics, TakeShot } from "../take/types.ts";
import {
  TAKE_ID,
  TAKE_ID_2,
  everyKeyProven,
  fixture,
  presenterShot,
  productShot,
  provenMetrics,
  recordedScores,
  unprovenMetrics,
} from "../test/helpers.ts";
import { takeGate, pickBestTake, type TakeGateInput } from "./take.ts";
import type { CriticOutcome } from "../critic.ts";

type Measurements = Record<string, unknown>;
const recorded = fixture<Record<string, Measurements>>("take-measurements");

const goodRubric = { hands: 0.92, faces: 0.95, anatomy: 0.9, physics: 0.88, plastic_skin: 0.8, morphing_objects: 0.93, background_warping: 0.9 };

function scored(table: Partial<Record<string, number>>, scorer = "similarity:recorded"): TakeGateInput["similarity"] {
  const outcomes: Record<string, SimilarityOutcome> = {};
  for (const [kind, score] of Object.entries(table)) {
    if (typeof score === "number") outcomes[kind] = { status: "scored", score, scorer };
  }
  return outcomes as TakeGateInput["similarity"];
}

function answered(rubric: Partial<typeof goodRubric> = {}, confidence = 0.91): CriticOutcome {
  return { status: "answered", rubric: { ...goodRubric, ...rubric }, confidence };
}

function input(overrides: Partial<TakeGateInput> = {}): TakeGateInput {
  return {
    takeId: TAKE_ID,
    shot: productShot(),
    measurements: recorded.clean,
    similarity: scored(recordedScores("clean")),
    critic: answered(),
    metrics: {},
    ...overrides,
  };
}

function withMetrics(metrics: TakeGoldMetrics): TakeGateInput["metrics"] {
  return metrics;
}

describe("takeGate: a clean take passes (Bible 6.7, 12.2)", () => {
  it("accepts a take that passes every code, similarity and Critic check, with its verdict and gate agreeing", () => {
    const outcome = takeGate(input());
    assert.equal(outcome.verdict.pass, true);
    assert.equal(outcome.verdict.action, "accept");
    assert.equal(outcome.gate.pass, true);
    assert.equal(outcome.gate.gate, "take");
    assert.equal(outcome.gate.subjectId, TAKE_ID);
    assert.equal(outcome.gate.failingShotIds, undefined);
    assert.deepEqual(outcome.missing, []);
    assert.deepEqual(outcome.provenFailures, []);
    assert.equal(outcome.reason, "every take check passes");
  });

  it("carries the Critic's confidence onto the verdict, and every check with its value", () => {
    const outcome = takeGate(input({ critic: answered({}, 0.87) }));
    assert.equal(outcome.verdict.confidence, 0.87);
    const rules = outcome.verdict.checks.map((check) => check.rule);
    for (const rule of [
      "duration_within_tolerance",
      "no_black_or_frozen_frames",
      "flicker_below_max",
      "motion_present",
      "product_match",
      "palette_match",
      "rubric_hands",
      "critic_confidence",
    ]) {
      assert.ok(rules.includes(rule), `missing ${rule}`);
    }
    assert.equal(outcome.verdict.checks.find((check) => check.rule === "product_match")?.score, 0.93);
  });

  it("the verdict and the gate result are both valid contracts", () => {
    const outcome = takeGate(input());
    assert.equal(takeVerdictSchema.safeParse(outcome.verdict).success, true);
    assert.equal(gateResultSchema.safeParse(outcome.gate).success, true);
  });

  it("a presenter shot is checked for persona, not product", () => {
    const outcome = takeGate(
      input({ shot: presenterShot(), similarity: scored({ face_vs_persona: 0.88, palette_vs_style_kit: 0.82 }) }),
    );
    const rules = outcome.verdict.checks.map((check) => check.rule);
    assert.ok(rules.includes("persona_match"));
    assert.equal(rules.includes("product_match"), false);
    assert.equal(outcome.verdict.pass, true);
  });
});

describe("takeGate: a deliberately warped product fails (Bible 12.2, 12.4)", () => {
  it("with no proven gold set, the warped take fails and escalates to review: it does not block", () => {
    const outcome = takeGate(input({ similarity: scored(recordedScores("warped_product")) }));
    assert.equal(outcome.verdict.pass, false);
    assert.equal(outcome.gate.pass, false);
    assert.equal(outcome.verdict.action, "escalate");
    assert.deepEqual(outcome.unprovenFailures, ["product_match"]);
    assert.deepEqual(outcome.provenFailures, []);
    assert.deepEqual(outcome.gate.failingShotIds, [productShot().shotId]);
  });

  it("with a gold set that meets the target, the same take fails and is redone with the product rule as the hint", () => {
    const outcome = takeGate(
      input({ similarity: scored(recordedScores("warped_product")), metrics: withMetrics({ "take:product_match": provenMetrics() }) }),
    );
    assert.equal(outcome.verdict.pass, false);
    assert.equal(outcome.verdict.action, "redo");
    assert.deepEqual(outcome.provenFailures, ["product_match"]);
    const failing = outcome.verdict.checks.filter((check) => !check.pass).map((check) => check.rule);
    assert.deepEqual(failing, ["product_match"]);
  });

  it("a gold set with too few labels (20) cannot block, however good its rates are", () => {
    const outcome = takeGate(
      input({
        similarity: scored(recordedScores("warped_product")),
        metrics: withMetrics({ "take:product_match": unprovenMetrics() }),
      }),
    );
    assert.equal(outcome.verdict.action, "escalate");
    assert.deepEqual(outcome.provenFailures, []);
  });
});

describe("takeGate: missing evidence is review, never pass", () => {
  it("a missing flicker measurement fails the take as not evaluated and escalates, even with every gold set proven", () => {
    const outcome = takeGate(input({ measurements: { ...recorded.clean, flickerScore: null }, metrics: everyKeyProven() }));
    assert.equal(outcome.verdict.pass, false);
    assert.equal(outcome.verdict.action, "escalate");
    assert.deepEqual(outcome.missing, ["flicker_below_max"]);
    assert.deepEqual(outcome.provenFailures, []);
    const flicker = outcome.verdict.checks.find((check) => check.rule === "flicker_below_max");
    assert.equal(flicker?.pass, false);
    assert.match(flicker?.detail ?? "", /^not evaluated: /);
  });

  it("a take whose probe did not measure a duration is missing evidence, not a pass", () => {
    const outcome = takeGate(input({ measurements: recorded.probe_missing }));
    assert.equal(outcome.verdict.pass, false);
    assert.equal(outcome.verdict.action, "escalate");
    assert.deepEqual(outcome.missing, ["duration_within_tolerance"]);
  });

  it("a measurement object that does not parse makes every code check missing", () => {
    const outcome = takeGate(input({ measurements: { durationMs: "4100" } }));
    assert.equal(outcome.verdict.action, "escalate");
    assert.equal(outcome.missing.length, 4);
  });

  it("a scorer that is not connected makes the similarity checks missing, so the take goes to review", () => {
    const notConnected = { status: "not_connected" as const, reason: NOT_CONNECTED_REASON };
    const outcome = takeGate(
      input({
        similarity: { product_vs_hero: notConnected, palette_vs_style_kit: notConnected },
        metrics: everyKeyProven(),
      }),
    );
    assert.equal(outcome.verdict.pass, false);
    assert.equal(outcome.verdict.action, "escalate");
    assert.deepEqual(outcome.missing, ["product_match", "palette_match"]);
    assert.match(outcome.reason, /not evaluated: product_match, palette_match/);
  });

  it("a required similarity result that was never recorded is missing evidence", () => {
    const outcome = takeGate(input({ similarity: scored({ palette_vs_style_kit: 0.9 }) }));
    assert.deepEqual(outcome.missing, ["product_match"]);
    assert.equal(outcome.verdict.action, "escalate");
  });

  it("a Critic with no answer escalates, with confidence 0 on the verdict and the rubric row as the reason", () => {
    const outcome = takeGate(input({ critic: { status: "not_answered", reason: "the Critic call was refused" }, metrics: everyKeyProven() }));
    assert.equal(outcome.verdict.pass, false);
    assert.equal(outcome.verdict.action, "escalate");
    assert.equal(outcome.verdict.confidence, 0);
    assert.deepEqual(outcome.missing, ["rubric_answered"]);
  });
});

describe("takeGate: the Critic's confidence and the rubric", () => {
  it("a Critic below the escalation threshold escalates, even when every rubric item passes", () => {
    const threshold = thresholds.escalation.criticConfidence.value;
    const outcome = takeGate(input({ critic: answered({}, threshold - 0.05), metrics: everyKeyProven() }));
    assert.equal(outcome.verdict.pass, false);
    assert.equal(outcome.verdict.action, "escalate");
    assert.deepEqual(outcome.unprovenFailures, ["critic_confidence"]);
    assert.deepEqual(outcome.provenFailures, []);
  });

  it("a confidence exactly at the threshold is not an escalation", () => {
    const outcome = takeGate(input({ critic: answered({}, thresholds.escalation.criticConfidence.value) }));
    assert.equal(outcome.verdict.pass, true);
    assert.equal(outcome.verdict.action, "accept");
  });

  it("a rubric item below its limit, proven by the slop-rubric gold set, is redone with that item as the hint", () => {
    const outcome = takeGate(
      input({ critic: answered({ morphing_objects: 0.5 }), metrics: withMetrics({ "take:slop_rubric": provenMetrics() }) }),
    );
    assert.equal(outcome.verdict.action, "redo");
    assert.deepEqual(outcome.provenFailures, ["rubric_morphing_objects"]);
    assert.deepEqual(outcome.verdict.checks.filter((check) => !check.pass).map((check) => check.rule), ["rubric_morphing_objects"]);
  });

  it("a rubric item below its limit with no gold set escalates, and the recorded hands answer is that case", () => {
    const hands = fixture<{ choices: Array<{ message: { content: string } }> }>("openrouter-critic-take-hands");
    const answer = JSON.parse(hands.choices[0]?.message.content ?? "null") as { rubric: typeof goodRubric; confidence: number };
    const outcome = takeGate(input({ critic: { status: "answered", rubric: answer.rubric, confidence: answer.confidence } }));
    assert.equal(outcome.verdict.action, "escalate");
    assert.deepEqual(outcome.unprovenFailures, ["rubric_hands"]);
  });
});

describe("takeGate: the routing of measured failures (Bible 5.3)", () => {
  it("a proven black-frame failure redoes the take", () => {
    const outcome = takeGate(
      input({ measurements: recorded.black_frames, metrics: withMetrics({ "take:no_black_or_frozen_frames": provenMetrics() }) }),
    );
    assert.equal(outcome.verdict.action, "redo");
    assert.deepEqual(outcome.provenFailures, ["no_black_or_frozen_frames"]);
  });

  it("a proven failure beside an unproven one still redoes; the unproven one is reported", () => {
    const outcome = takeGate(
      input({
        measurements: recorded.black_frames,
        similarity: scored(recordedScores("warped_product")),
        metrics: withMetrics({ "take:no_black_or_frozen_frames": provenMetrics() }),
      }),
    );
    assert.equal(outcome.verdict.action, "redo");
    assert.deepEqual(outcome.provenFailures, ["no_black_or_frozen_frames"]);
    assert.deepEqual(outcome.unprovenFailures, ["product_match"]);
  });

  it("a proven failure beside a missing check still escalates: missing evidence routes to review", () => {
    const outcome = takeGate(
      input({
        measurements: { ...recorded.black_frames, flickerScore: null },
        metrics: everyKeyProven(),
      }),
    );
    assert.equal(outcome.verdict.action, "escalate");
    assert.deepEqual(outcome.missing, ["flicker_below_max"]);
  });

  it("a long take (17 per cent over the shot) with no proven gold set escalates, and with a proven one it is redone", () => {
    const unproven = takeGate(input({ measurements: recorded.too_long }));
    assert.equal(unproven.verdict.action, "escalate");
    const proven = takeGate(
      input({ measurements: recorded.too_long, metrics: withMetrics({ "take:duration_within_tolerance": provenMetrics() }) }),
    );
    assert.equal(proven.verdict.action, "redo");
  });

  it("a static motion shot with a proven motion gold set is redone", () => {
    const outcome = takeGate(
      input({ measurements: recorded.static_motion_shot, metrics: withMetrics({ "take:motion_present": provenMetrics() }) }),
    );
    assert.equal(outcome.verdict.action, "redo");
    assert.deepEqual(outcome.provenFailures, ["motion_present"]);
  });

  it("the gate never returns a downgrade: that is the orchestrator's decision after two redos", () => {
    const actions = [
      takeGate(input()).verdict.action,
      takeGate(input({ measurements: recorded.black_frames, metrics: everyKeyProven() })).verdict.action,
      takeGate(input({ measurements: { ...recorded.clean, flickerScore: null } })).verdict.action,
    ];
    assert.ok(actions.every((action) => action !== "downgrade"));
  });
});

describe("takeGate: the gate and the verdict always agree", () => {
  it("for every scenario, gate.pass equals verdict.pass and a failing gate names the shot", () => {
    const scenarios: TakeGateInput[] = [
      input(),
      input({ similarity: scored(recordedScores("warped_product")) }),
      input({ measurements: recorded.black_frames }),
      input({ measurements: { ...recorded.clean, flickerScore: null } }),
      input({ critic: { status: "not_answered", reason: "refused" } }),
      input({ critic: answered({}, 0.2) }),
    ];
    for (const scenario of scenarios) {
      const outcome = takeGate(scenario);
      assert.equal(outcome.gate.pass, outcome.verdict.pass);
      if (!outcome.verdict.pass) {
        assert.deepEqual(outcome.gate.failingShotIds, [productShot().shotId]);
      }
    }
  });

  it("the reason names rule names and routes, and carries no model text", () => {
    const outcome = takeGate(input({ critic: answered({}, 0.2) }));
    assert.equal(outcome.reason, "escalate: failing without a proven gold set: critic_confidence");
  });
});

describe("takeGate: invalid input is refused, not turned into a verdict", () => {
  it("a take id that is not a take_ id is invalid_input", () => {
    assert.throws(() => takeGate(input({ takeId: "req_01JABCDEFGHJKMNPQRSTVWXYZ0" })), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  });

  it("a shot that does not parse is invalid_input: it is plan data, not evidence", () => {
    const shot = { ...productShot(), plannedDurationMs: 0 } as unknown as TakeShot;
    assert.throws(() => takeGate(input({ shot })), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  });
});

describe("pickBestTake: best of two (Bible 6.7 step 4)", () => {
  function verdict(takeId: string, pass: boolean, confidence: number): TakeVerdict {
    return {
      takeId,
      pass,
      confidence,
      checks: [{ rule: "flicker_below_max", pass }],
      action: pass ? "accept" : "redo",
    };
  }

  it("picks the passing take with the highest confidence", () => {
    const best = pickBestTake([verdict(TAKE_ID, true, 0.8), verdict(TAKE_ID_2, true, 0.93)]);
    assert.equal(best?.takeId, TAKE_ID_2);
  });

  it("ignores a take that failed, even when its confidence is higher", () => {
    const best = pickBestTake([verdict(TAKE_ID, false, 0.99), verdict(TAKE_ID_2, true, 0.7)]);
    assert.equal(best?.takeId, TAKE_ID_2);
  });

  it("on a tie of confidence, picks the lower take id, the same order the orchestrator uses", () => {
    const best = pickBestTake([verdict(TAKE_ID_2, true, 0.8), verdict(TAKE_ID, true, 0.8)]);
    assert.equal(best?.takeId, TAKE_ID);
  });

  it("returns null when no take passed, and does not change its input order", () => {
    const list = [verdict(TAKE_ID, false, 0.9), verdict(TAKE_ID_2, false, 0.5)];
    assert.equal(pickBestTake(list), null);
    assert.equal(list[0]?.takeId, TAKE_ID);
  });
});
