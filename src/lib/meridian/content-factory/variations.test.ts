import assert from "node:assert/strict";
import test from "node:test";
import { MASTER_COST_FLOOR_USD } from "../factory/run-settings.ts";
import { angleInstruction, centsOf, MAX_VARIATIONS, minItemCents, sourceProblem, splitBudget, VARIATION_ANGLES } from "./variations.ts";

test("there are twenty distinct fixed angles, and every instruction carries the same originality rules", () => {
  assert.equal(VARIATION_ANGLES.length, MAX_VARIATIONS);
  assert.equal(new Set(VARIATION_ANGLES.map((angle) => angle.id)).size, 20);
  assert.equal(new Set(VARIATION_ANGLES.map((angle) => angle.label)).size, 20);
  for (const angle of VARIATION_ANGLES) {
    const text = angleInstruction(angle);
    assert.match(text, /only for transferable structure and pacing/);
    assert.match(text, /Never copy its footage, words, voice or music/);
    assert.match(text, /Ground every claim in the attached brand and Market evidence/);
    assert.match(text, /leave out any claim that evidence does not support/);
  }
});

test("a budget is whole cents, and the split is exact, within a cent, and never below the floor", () => {
  assert.equal(centsOf(10.4), 1040);
  assert.equal(centsOf(0.1 + 0.2), 30);
  assert.equal(centsOf(1.005), null, "more than two decimals is refused, not rounded");
  assert.equal(centsOf(0), null);
  const split = splitBudget(12.34, 20);
  assert.ok(split.ok);
  if (!split.ok) return;
  assert.equal(split.cents.reduce((sum, cents) => sum + cents, 0), 1234, "the parts add up to the total exactly");
  assert.ok(Math.max(...split.cents) - Math.min(...split.cents) <= 1);
  assert.ok(Math.min(...split.cents) >= minItemCents());
  const three = splitBudget(10, 3);
  assert.ok(three.ok);
  if (three.ok) assert.deepEqual(three.cents, [334, 333, 333]);
});

test("a budget that cannot cover the count, a count outside 2 to 20, and a per-video amount over the limit are refused", () => {
  const floor = Math.ceil(MASTER_COST_FLOOR_USD * 100);
  assert.equal(minItemCents(), floor);
  const low = splitBudget((floor * 3 - 1) / 100, 3);
  assert.equal(low.ok, false);
  assert.ok(splitBudget((floor * 3) / 100, 3).ok, "exactly the floor for each video is enough");
  assert.equal(splitBudget(10, 1).ok, false);
  assert.equal(splitBudget(10, 21).ok, false);
  assert.equal(splitBudget(10, 2.5).ok, false);
  const high = splitBudget(2001, 2);
  assert.equal(high.ok, false, "$1,000.50 each is over the per-video limit");
  assert.ok(splitBudget(2000, 2).ok);
});

test("a source draft needs a draft, a brand, an uploaded reference, Market research and a plain instruction, and no script lines", () => {
  const good = { status: "draft", brandId: "b", hasReferenceVideo: true, marketAttachments: 1, instructions: ["Make a calm product demo."], scriptLines: 0 };
  assert.equal(sourceProblem(good), null);
  assert.match(sourceProblem({ ...good, status: "started" }) ?? "", /Only a draft/);
  assert.match(sourceProblem({ ...good, brandId: null }) ?? "", /no brand/);
  assert.match(sourceProblem({ ...good, hasReferenceVideo: false }) ?? "", /uploaded reference video/);
  assert.match(sourceProblem({ ...good, marketAttachments: 0 }) ?? "", /Market research/);
  assert.match(sourceProblem({ ...good, scriptLines: 1 }) ?? "", /script lines/);
  assert.match(sourceProblem({ ...good, instructions: ["", "short"] }) ?? "", /plain-language instruction/);
});
