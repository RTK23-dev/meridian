/**
 * Per-question perception contracts. Each visual question is checked against its own contract. A contract the observations do
 * not satisfy writes no lines at all, so an unknown fact is never shown to any question, not even as absent.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PERCEPTION_EVIDENCE_NAME, checkQuestionContract, satisfiedContractLines } from "./contracts.ts";
import type { MediaObservation } from "./types.ts";

const visualFacts = { sharpness: "sharp", lighting: "good", composition: "balanced", legibility: "no_text", artifactsVisible: false } as const;
const productFacts = { productPresence: true, productProminence: "prominent", productObstructed: false } as const;

const observation = (over: Partial<MediaObservation> = {}): MediaObservation =>
  ({ mediaId: "m1", sha256: "a".repeat(64), timestampMs: null, basis: "inferred", ...visualFacts, ...productFacts, ...over }) as MediaObservation;

const label = () => "Image";
const provenance = "stub-provider stub-model (prompt test)";

test("the perception evidence item has one stable name", () => {
  assert.equal(PERCEPTION_EVIDENCE_NAME, "perception_observations");
});

test("a question's check is its own contract: visual-only facts do not satisfy the product contract", () => {
  const visualOnly = [observation({ productPresence: undefined, productProminence: undefined, productObstructed: undefined } as Partial<MediaObservation>)];
  assert.equal(checkQuestionContract("visual_quality", visualOnly).satisfied, true);
  const product = checkQuestionContract("product_visibility", visualOnly);
  assert.equal(product.satisfied, false, "another contract's facts never satisfy this question");
});

test("an unknown product presence is unknown, never absent: the product contract is not satisfied and none of its lines are written", () => {
  const observed = [observation({ productPresence: null })];
  assert.equal(checkQuestionContract("product_visibility", observed).satisfied, false);
  const { satisfied, lines } = satisfiedContractLines(observed, label, provenance);
  assert.deepEqual(satisfied, ["visual_quality"], "only the satisfied contract is written");
  assert.equal(lines.product_visibility, undefined, "no product line is written for an unsatisfied contract");
  assert.doesNotMatch(JSON.stringify(lines), /productPresence/, "no unknown product fact is written, even as absent");
});

test("a fully observed run writes the lines of both contracts, with the facts it reported", () => {
  const { satisfied, lines } = satisfiedContractLines([observation()], label, provenance);
  assert.deepEqual(satisfied.sort(), ["product_visibility", "visual_quality"]);
  assert.match(lines.product_visibility?.[0] ?? "", /\[product_visibility 1\.0\.0\] productPresence=true; productProminence=prominent; productObstructed=false/);
  assert.match(lines.visual_quality?.[0] ?? "", /\[visual_quality 1\.0\.0\] sharpness=sharp/);
});

test("a question with no contract, an unknown contract, or no observations is never satisfied", () => {
  assert.equal(checkQuestionContract(undefined, [observation()]).satisfied, false);
  assert.equal(checkQuestionContract("no_such_contract", [observation()]).satisfied, false);
  assert.equal(checkQuestionContract("visual_quality", []).satisfied, false, "no observations is not evidence");
});
