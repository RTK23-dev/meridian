import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { thresholds } from "../../config/thresholds.ts";
import { EngineError } from "../../contracts/errors.ts";
import { GOLD_LABEL_SCHEMA, GOLD_TARGETS, type GoldLabel } from "../gold.ts";
import { fixtureText } from "../test/helpers.ts";
import { loadTakeGold, predictTakeFail, takeGoldMetrics } from "./gold.ts";
import { TAKE_GOLD_KEYS } from "./types.ts";

const SUBJECT = "take_01JABCDEFGHJKMNPQRSTVWXYZ1";

function label(index: number, check: string, shouldFail: boolean, input: unknown): GoldLabel {
  return {
    schema: GOLD_LABEL_SCHEMA,
    labelId: `${check}-${index}`,
    check,
    subjectId: SUBJECT,
    shouldFail,
    source: "owner_seed",
    reason: "synthetic label for a metrics test",
    input,
  } as GoldLabel;
}

/** Two hundred product labels: 100 failing (90 scored under the limit) and 100 passing (10 scored under the limit). */
function productLabels(): GoldLabel[] {
  const labels: GoldLabel[] = [];
  for (let index = 0; index < 100; index++) {
    labels.push(label(index, "take:product_match", true, { score: index < 90 ? 0.41 : 0.9 }));
  }
  for (let index = 0; index < 100; index++) {
    labels.push(label(index + 100, "take:product_match", false, { score: index < 10 ? 0.5 : 0.93 }));
  }
  return labels;
}

describe("take gold-set loader (Bible 12.4)", () => {
  it("loads the bundled sample: every label is a take check, and no check has enough labels to block", () => {
    const set = loadTakeGold(fixtureText("take-gold"));
    assert.equal(set.labels.length, 8);
    for (const key of TAKE_GOLD_KEYS) {
      assert.equal(set.metrics[key].meetsTarget, false, key);
      assert.equal(set.metrics[key].enoughLabels, false, key);
    }
  });

  it("predicts a check's failure with the gate's own rule: a warped product, a flickering take and a rubric flaw fail", () => {
    const set = loadTakeGold(fixtureText("take-gold"));
    const byId = new Map(set.labels.map((item) => [item.labelId, item]));
    assert.equal(predictTakeFail("take:flicker_below_max", byId.get("tg_flicker_02")?.input), true);
    assert.equal(predictTakeFail("take:flicker_below_max", byId.get("tg_flicker_01")?.input), false);
    assert.equal(predictTakeFail("take:product_match", byId.get("tg_product_02")?.input), true);
    assert.equal(predictTakeFail("take:product_match", byId.get("tg_product_01")?.input), false);
    assert.equal(predictTakeFail("take:slop_rubric", byId.get("tg_rubric_01")?.input), true);
    assert.equal(predictTakeFail("take:duration_within_tolerance", byId.get("tg_duration_01")?.input), true);
    assert.equal(predictTakeFail("take:no_black_or_frozen_frames", byId.get("tg_black_01")?.input), true);
    assert.equal(predictTakeFail("take:motion_present", byId.get("tg_motion_01")?.input), true);
  });

  it("a code label whose measurement is missing predicts a failure, the same as the gate", () => {
    const input = { shot: { plannedDurationMs: 4000, motionRequired: false }, measurements: { durationMs: null, blackOrFrozenRunFrames: 0, flickerScore: 0.1, meanMotion: null } };
    assert.equal(predictTakeFail("take:duration_within_tolerance", input), true);
  });

  it("a label that names a check outside the take gate is invalid_input, and nothing is loaded", () => {
    const text = JSON.stringify([label(1, "plan:shots_tile_voice_duration", true, {})]);
    assert.throws(() => loadTakeGold(text), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input" && /not a take check/.test(error.message));
  });

  it("a label whose input does not match its check is invalid_input, and names the label", () => {
    const text = JSON.stringify([label(2, "take:product_match", true, { score: "high" })]);
    assert.throws(
      () => loadTakeGold(text),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input" && error.message.includes("product_match-2"),
    );
  });

  it("text that is not JSON, and a repeated label id, are invalid_input", () => {
    assert.throws(() => loadTakeGold("[not json"), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
    const repeated = JSON.stringify([label(3, "take:product_match", true, { score: 0.4 }), label(3, "take:product_match", true, { score: 0.4 })]);
    assert.throws(() => loadTakeGold(repeated), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  });

  it("a set with 200 labels that meets the target (recall 0.90, false-fail 0.10) makes product_match eligible to block", () => {
    const labels = productLabels();
    assert.equal(labels.length, GOLD_TARGETS.examplesToStart);
    const metrics = takeGoldMetrics(labels);
    assert.equal(metrics["take:product_match"].recall, 0.9);
    assert.equal(metrics["take:product_match"].falseFailRate, 0.1);
    assert.equal(metrics["take:product_match"].meetsTarget, true);
    assert.equal(metrics["take:flicker_below_max"].meetsTarget, false);
  });

  it("the rubric's thresholds come from configuration, so a change there changes the prediction", () => {
    const floor = thresholds.take.slopRubricItemMin.value;
    const rubric = { hands: floor, faces: 0.95, anatomy: 0.9, physics: 0.9, plastic_skin: 0.9, morphing_objects: 0.9, background_warping: 0.9 };
    assert.equal(predictTakeFail("take:slop_rubric", { rubric }), false);
    assert.equal(predictTakeFail("take:slop_rubric", { rubric: { ...rubric, hands: floor - 0.01 } }), true);
  });
});
