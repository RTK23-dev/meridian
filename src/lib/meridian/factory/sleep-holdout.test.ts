import assert from "node:assert/strict";
import test from "node:test";
import { challengerArmOf, drawOf, holdoutArmOf } from "./sleep-holdout.ts";

test("a draw is a number in [0, 1), the same for the same key", () => {
  const draw = drawOf("holdout:tpl:run_1:research_1");
  assert.ok(draw >= 0 && draw < 1);
  assert.equal(drawOf("holdout:tpl:run_1:research_1"), draw);
});

test("an item keeps its arm on every call", () => {
  const arm = holdoutArmOf("tpl:run_1:research_1", 0.1);
  assert.equal(holdoutArmOf("tpl:run_1:research_1", 0.1), arm);
});

test("a share of 0 holds nothing, and a share of 1 holds everything", () => {
  for (let index = 0; index < 200; index += 1) {
    assert.equal(holdoutArmOf(`tpl:run_x:${index}`, 0), "treated");
    assert.equal(holdoutArmOf(`tpl:run_x:${index}`, 1), "holdout");
  }
});

test("about a tenth of 10,000 planned items fall in the holdout at a share of 0.1", () => {
  // The draw is a hash, so the count is fixed for these ids. With 10,000 items the expected count is 1,000 and the standard
  // deviation about 30, so the band below is far wider than sampling noise.
  let held = 0;
  for (let index = 0; index < 10_000; index += 1) {
    if (holdoutArmOf(`tpl:run_fixture:research_${index}`, 0.1) === "holdout") held += 1;
  }
  assert.ok(held >= 850 && held <= 1150, `held out ${held} of 10000`);
});

test("with no challenger version registered, every call is control and the reason says no challenger ran", () => {
  const choice = challengerArmOf("director_check:call_1", 0.1, []);
  assert.equal(choice.arm, "control");
  assert.equal(choice.version, null);
  assert.match(choice.reason, /no challenger ran/);
});

test("with a registered version, a share of 1 routes every call to a challenger version, and 0 routes none", () => {
  const versions = ["director_check@2"];
  for (let index = 0; index < 50; index += 1) {
    const all = challengerArmOf(`director_check:call_${index}`, 1, versions);
    assert.equal(all.arm, "challenger");
    assert.equal(all.version, "director_check@2");
    assert.equal(challengerArmOf(`director_check:call_${index}`, 0, versions).arm, "control");
  }
});

test("a bad share throws rather than routing", () => {
  assert.throws(() => holdoutArmOf("tpl:x", 1.5), /between 0 and 1/);
  assert.throws(() => challengerArmOf("call", -0.1, ["v1"]), /between 0 and 1/);
});
