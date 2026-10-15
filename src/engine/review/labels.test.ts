import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/errors.ts";
import { takeVerdictSchema, type TakeVerdict } from "../contracts/take.ts";
import { FINAL_RUBRIC_ITEMS } from "../claude/roles/critic_final.ts";
import { SLOP_RUBRIC_ITEMS } from "../claude/roles/critic_take.ts";
import { loadTakeGold } from "./take/gold.ts";
import { gateReviewItem, takeReviewItem } from "./inbox.ts";
import { checkPostRender } from "./gates/postRender.ts";
import { cleanPostRenderInput, cleanRender, VIDEO_ID } from "./test/render.ts";
import { REQUEST_ID, SHOT_ID, TAKE_ID, TAKE_ID_2 } from "./test/helpers.ts";
import { labelsFromGateDecision, labelsFromTakeDecision, loadCriticFinalGold, predictCriticFinalFail } from "./labels.ts";
import { goldLabelSchema } from "./gold.ts";

/** A verdict with the seven rubric scores, a product similarity score and a duration check, as check_take writes it. */
function verdict(takeId: string, rubricScore: number, productScore: number, durationPass = true): TakeVerdict {
  const rubric = SLOP_RUBRIC_ITEMS.map((item) => ({ rule: `rubric_${item}`, pass: rubricScore >= 0.7, score: rubricScore }));
  const product = { rule: "product_match", pass: productScore >= 0.85, score: productScore };
  return takeVerdictSchema.parse({
    takeId,
    pass: rubricScore >= 0.7 && productScore >= 0.85 && durationPass,
    confidence: 0.9,
    checks: [...rubric, product, { rule: "duration_within_tolerance", pass: durationPass }, { rule: "critic_confidence", pass: true, score: 0.9 }],
    action: rubricScore >= 0.7 && productScore >= 0.85 && durationPass ? "accept" : "redo",
  });
}

function takeItem(overrides: { first?: TakeVerdict; second?: TakeVerdict } = {}) {
  const first = overrides.first ?? verdict(TAKE_ID, 0.4, 0.41);
  const second = overrides.second ?? verdict(TAKE_ID_2, 0.92, 0.9);
  return takeReviewItem({
    requestId: REQUEST_ID,
    shotId: SHOT_ID,
    visualType: "product_hero",
    reason: "escalated: the Critic and the product check disagree",
    planArtifactId: null,
    takes: [
      { takeId: TAKE_ID, takeArtifactId: null, verdictArtifactId: null, verdict: first },
      { takeId: TAKE_ID_2, takeArtifactId: null, verdictArtifactId: null, verdict: second },
    ],
  });
}

function labelsOf(outcome: { labels: { check: string; shouldFail: boolean; subjectId: string }[] }) {
  return outcome.labels.map((item) => `${item.subjectId} ${item.check} ${item.shouldFail ? "fail" : "pass"}`).sort();
}

describe("review decisions on a take item become gold labels (Bible 12.4, 12.5)", () => {
  it("accepting a take labels its rubric and its similarity as passing, and says what it could not label", () => {
    const outcome = labelsFromTakeDecision(takeItem(), { action: "accept", takeId: TAKE_ID, reason: "the hands are fine on a close look" });
    assert.deepEqual(labelsOf(outcome), [`${TAKE_ID} take:product_match pass`, `${TAKE_ID} take:slop_rubric pass`]);
    for (const item of outcome.labels) {
      assert.equal(goldLabelSchema.safeParse(item).success, true);
      assert.equal(item.source, "human_review");
      assert.equal(item.reason, "the hands are fine on a close look");
    }
    assert.ok(outcome.skipped.some((item) => item.check === "duration_within_tolerance" && /no measurements/.test(item.reason)));
    assert.equal(outcome.skipped.some((item) => item.check === "critic_confidence"), false, "the confidence has no gold set and is never listed");
  });

  it("the take labels load with the take gold loader, so a reviewer's decision is usable gold", () => {
    const outcome = labelsFromTakeDecision(takeItem(), { action: "accept", takeId: TAKE_ID, reason: "accepted on review" });
    const set = loadTakeGold(JSON.stringify(outcome.labels));
    assert.equal(set.metrics["take:slop_rubric"].total, 1);
    assert.equal(set.metrics["take:slop_rubric"].passLabels, 1);
  });

  it("rejecting a take labels only the checks that failed: the rubric is failing, so it is a failing label", () => {
    const outcome = labelsFromTakeDecision(takeItem(), { action: "reject", reason: "the product is warped" });
    assert.deepEqual(labelsOf(outcome), [`${TAKE_ID} take:product_match fail`, `${TAKE_ID} take:slop_rubric fail`]);
  });

  it("rejecting a take whose rubric passed gives no rubric label: a rejection does not say which item should have failed", () => {
    const passing = verdict(TAKE_ID, 0.92, 0.5);
    const outcome = labelsFromTakeDecision(takeItem({ first: passing }), { action: "reject", takeId: TAKE_ID, reason: "wrong lighting" });
    assert.deepEqual(labelsOf(outcome), [`${TAKE_ID} take:product_match fail`]);
    assert.ok(outcome.skipped.every((item) => item.check !== "take:slop_rubric"), "no skip either: the rubric was simply not judged by the rejection");
  });

  it("choosing another take accepts the chosen one only; the other take gives no label", () => {
    const outcome = labelsFromTakeDecision(takeItem(), { action: "choose_take", takeId: TAKE_ID_2, reason: "the second take is the clean one" });
    assert.deepEqual(labelsOf(outcome), [`${TAKE_ID_2} take:product_match pass`, `${TAKE_ID_2} take:slop_rubric pass`]);
  });

  it("the plan decisions label nothing, and say why", () => {
    for (const action of ["change_visual_type", "edit_prompt"] as const) {
      const outcome = labelsFromTakeDecision(takeItem(), { action, reason: "a different type reads better" });
      assert.equal(outcome.labels.length, 0);
      assert.match(outcome.skipped[0]?.reason ?? "", /changes the plan/);
    }
  });

  it("an accept or choose without a take, or with a take the item does not hold, is refused", () => {
    assert.throws(() => labelsFromTakeDecision(takeItem(), { action: "accept", reason: "ok" }), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
    assert.throws(
      () => labelsFromTakeDecision(takeItem(), { action: "choose_take", takeId: "take_01JABCDEFGHJKMNPQRSTVWXYZ9", reason: "ok" }),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
  });

  it("a decision with no reason is refused: every label carries the reviewer's reason (Bible 12.5)", () => {
    assert.throws(() => labelsFromTakeDecision(takeItem(), { action: "reject", reason: "   " }), (error: unknown) => error instanceof EngineError);
  });

  it("an item that does not parse is refused rather than labelled", () => {
    assert.throws(() => labelsFromTakeDecision({ schema: "meridian.take_review/v1" }, { action: "reject", reason: "bad" }), (error: unknown) => error instanceof EngineError);
  });
});

function gateItem(critic: "low" | "clean") {
  const render = cleanRender();
  const base = cleanPostRenderInput(render);
  const outcome = checkPostRender({
    ...base,
    critic:
      critic === "low"
        ? { status: "answered", rubric: { ...Object.fromEntries(FINAL_RUBRIC_ITEMS.map((item) => [item, 0.9])), hands: 0.4 } as never, confidence: 0.9, answeredBy: "haiku" }
        : { status: "answered", rubric: Object.fromEntries(FINAL_RUBRIC_ITEMS.map((item) => [item, 0.9])) as never, confidence: 0.9, answeredBy: "haiku" },
  });
  return gateReviewItem({ requestId: REQUEST_ID, gate: outcome.gate, resultArtifactId: null, failures: outcome.failures });
}

describe("review decisions on a gate item become gold labels (Bible 12.4)", () => {
  it("the gate item carries the nine rubric values and names the failing rule", () => {
    const item = gateItem("low");
    assert.equal(item.gate, "post_render");
    assert.equal(item.subjectId, VIDEO_ID);
    assert.ok(item.failing.includes("rubric_hands"));
    assert.deepEqual(item.actions, ["accept", "reject"]);
  });

  it("accepting a video with a failing rubric labels the rubric as passing (a false alarm)", () => {
    const outcome = labelsFromGateDecision(gateItem("low"), { action: "accept", reason: "the hands are a close-up reflection" });
    assert.equal(outcome.labels.length, 1);
    assert.equal(outcome.labels[0]?.check, "post_render:critic_final");
    assert.equal(outcome.labels[0]?.shouldFail, false);
    assert.equal(predictCriticFinalFail(outcome.labels[0]?.input), true, "the gate's own rule would have failed this label");
  });

  it("rejecting a video whose rubric failed labels the rubric as failing", () => {
    const outcome = labelsFromGateDecision(gateItem("low"), { action: "reject", reason: "the hand morphs" });
    assert.equal(outcome.labels[0]?.shouldFail, true);
  });

  it("rejecting a video whose rubric passed gives no label, and says so", () => {
    const outcome = labelsFromGateDecision(gateItem("clean"), { action: "reject", reason: "the overlay is broken" });
    assert.equal(outcome.labels.length, 0);
    assert.match(outcome.skipped[0]?.reason ?? "", /rubric passed/);
  });

  it("the critic labels load with their own loader, and the metrics count them with the gate's rule", () => {
    const accepted = labelsFromGateDecision(gateItem("low"), { action: "accept", reason: "false alarm" });
    const rejected = labelsFromGateDecision(gateItem("low"), { action: "reject", reason: "real defect" });
    const set = loadCriticFinalGold(JSON.stringify([...accepted.labels, ...rejected.labels]));
    assert.equal(set.metrics.total, 2);
    assert.equal(set.metrics.passLabels, 1);
    assert.equal(set.metrics.failLabels, 1);
  });

  it("a pre_render item has no gold input in it, so every check is listed and nothing is labelled", () => {
    const render = cleanRender();
    const pre = gateReviewItem({
      requestId: REQUEST_ID,
      gate: { gate: "pre_render", subjectId: render.edl.edlId, checks: [{ rule: "slideshow_coded_run", pass: false, value: 5, limit: 4 }] },
      resultArtifactId: null,
      failures: [{ rule: "slideshow_coded_run" }],
    });
    const outcome = labelsFromGateDecision(pre, { action: "reject", reason: "a real slideshow" });
    assert.equal(outcome.labels.length, 0);
    assert.equal(outcome.skipped[0]?.check, "slideshow_coded_run");
  });

  it("a render gate offers accept and reject only", () => {
    assert.throws(() => labelsFromGateDecision(gateItem("low"), { action: "choose_take", takeId: TAKE_ID, reason: "no" }), (error: unknown) => error instanceof EngineError);
  });

  it("the critic gold loader refuses a label for another check, and one whose scores do not match", () => {
    const wrong = JSON.stringify([{ ...labelsFromGateDecision(gateItem("low"), { action: "accept", reason: "x" }).labels[0], check: "post_render:overlays_present" }]);
    assert.throws(() => loadCriticFinalGold(wrong), (error: unknown) => error instanceof EngineError);
    const badInput = JSON.stringify([{ ...labelsFromGateDecision(gateItem("low"), { action: "accept", reason: "x" }).labels[0], input: { rubric: { hands: 0.9 } } }]);
    assert.throws(() => loadCriticFinalGold(badInput), (error: unknown) => error instanceof EngineError);
  });
});

describe("the gate item builder", () => {
  it("refuses a gate that is not a render gate", () => {
    assert.throws(
      () => gateReviewItem({ requestId: REQUEST_ID, gate: { gate: "take", subjectId: TAKE_ID, checks: [{ rule: "x", pass: false }] }, resultArtifactId: null, failures: [] }),
      (error: unknown) => error instanceof EngineError,
    );
  });

  it("the reason is built from rule names, never from free text", () => {
    const item = gateItem("low");
    assert.match(item.reason, /^post_render failed without a proven gold set: rubric_hands/);
  });
});
