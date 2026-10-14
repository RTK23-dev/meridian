import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/errors.ts";
import { takeVerdictSchema, type TakeVerdict } from "../contracts/take.ts";
import { TAKE_REVIEW_ACTIONS, TAKE_REVIEW_SCHEMA, takeReviewItem, takeReviewItemSchema } from "./inbox.ts";
import { REQUEST_ID, SHOT_ID, TAKE_ID, TAKE_ID_2 } from "./test/helpers.ts";

const PLAN_ID = "art_01JABCDEFGHJKMNPQRSTVWXYZ0";
const TAKE_ARTIFACT = "art_01JABCDEFGHJKMNPQRSTVWXYZ1";
const VERDICT_ARTIFACT = "art_01JABCDEFGHJKMNPQRSTVWXYZ2";

const acceptVerdict: TakeVerdict = takeVerdictSchema.parse({
  takeId: TAKE_ID,
  pass: true,
  confidence: 0.91,
  checks: [
    { rule: "duration_within_tolerance", pass: true, score: 0.025, detail: "take 4100 ms against shot 4000 ms" },
    { rule: "product_match", pass: true, score: 0.93 },
  ],
  action: "accept",
});

const escalateVerdict: TakeVerdict = takeVerdictSchema.parse({
  takeId: TAKE_ID_2,
  pass: false,
  confidence: 0.45,
  checks: [
    { rule: "product_match", pass: false, detail: "not evaluated: the scorer is not connected" },
    { rule: "rubric_hands", pass: false, score: 0.35 },
    { rule: "rubric_hands", pass: false, score: 0.35 },
    { rule: "critic_confidence", pass: false, score: 0.45, detail: "the Critic is unsure of its rubric, so the take goes to a human" },
  ],
  action: "escalate",
});

function item(overrides: Partial<Parameters<typeof takeReviewItem>[0]> = {}) {
  return takeReviewItem({
    requestId: REQUEST_ID,
    shotId: SHOT_ID,
    visualType: "product_hero",
    reason: "the shot has no passing take, and one take needs a human",
    planArtifactId: PLAN_ID,
    takes: [
      { takeId: TAKE_ID, takeArtifactId: TAKE_ARTIFACT, verdictArtifactId: VERDICT_ARTIFACT, verdict: acceptVerdict },
      { takeId: TAKE_ID_2, takeArtifactId: null, verdictArtifactId: null, verdict: escalateVerdict },
    ],
    ...overrides,
  });
}

describe("take review item (Bible 5.3, 12.5)", () => {
  it("builds an escalation item that names the shot, the plan and every take with its checks", () => {
    const review = item();
    assert.equal(review.schema, TAKE_REVIEW_SCHEMA);
    assert.equal(review.kind, "escalation");
    assert.equal(review.shotId, SHOT_ID);
    assert.equal(review.planArtifactId, PLAN_ID);
    assert.deepEqual(review.takes.map((take) => take.takeId), [TAKE_ID, TAKE_ID_2]);
    assert.equal(review.takes[0]?.takeArtifactId, TAKE_ARTIFACT);
    assert.equal(review.takes[0]?.verdictArtifactId, VERDICT_ARTIFACT);
    assert.equal(review.takes[0]?.checks.length, 2);
    assert.equal(review.takes[0]?.checks[0]?.detail, "take 4100 ms against shot 4000 ms");
  });

  it("offers the five reviewer actions of Bible 12.5, in order", () => {
    assert.deepEqual([...item().actions], ["accept", "choose_take", "change_visual_type", "edit_prompt", "reject"]);
    assert.deepEqual([...TAKE_REVIEW_ACTIONS], ["accept", "choose_take", "change_visual_type", "edit_prompt", "reject"]);
  });

  it("lists each take's failing rules once and sorted, the hints a redo would have carried", () => {
    const failing = item().takes[1]?.failing;
    assert.deepEqual(failing, ["critic_confidence", "product_match", "rubric_hands"]);
    assert.deepEqual(item().takes[0]?.failing, []);
  });

  it("an id that was not stored is null, not invented", () => {
    const review = item();
    assert.equal(review.takes[1]?.takeArtifactId, null);
    assert.equal(review.takes[1]?.verdictArtifactId, null);
    const noPlan = item({ planArtifactId: null });
    assert.equal(noPlan.planArtifactId, null);
  });

  it("survives a JSON round trip unchanged, so it can be stored as the review item's detail", () => {
    const review = item();
    const back = takeReviewItemSchema.parse(JSON.parse(JSON.stringify(review)));
    assert.deepEqual(back, review);
  });

  it("refuses a shot id that is not a shot_ id, and an empty reason, as invalid_input", () => {
    assert.throws(() => item({ shotId: TAKE_ID }), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
    assert.throws(() => item({ reason: "" }), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  });

  it("refuses a request with no takes, since an escalation without a take has nothing to review", () => {
    assert.throws(() => item({ takes: [] }), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  });
});
