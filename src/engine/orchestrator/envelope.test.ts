import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { INITIAL_BUDGET_TOLERANCE } from "../budget/tolerance.ts";
import { allowancesOf, categoryEnvelopesOf, envelopeOf, positionOf } from "./envelope.ts";

describe("the envelopes of a run and of its categories (owner direction 2026-10-23)", () => {
  it("a plan's envelope targets the lower of its own budget and the budget the user set, and allows the tolerance on that target", () => {
    const envelope = envelopeOf(3, 2);
    assert.equal(envelope.targetUsd, 2);
    assert.equal(envelope.allowanceUsd, 2.25, "the initial tolerance is the larger of 10 percent and 25 cents");
  });

  it("a category the brief sets has its own envelope; a category it leaves unset has none", () => {
    const envelopes = categoryEnvelopesOf({ copy: 1 });
    assert.deepEqual(envelopes.copy, { targetUsd: 1, allowanceUsd: 1.25, tolerance: INITIAL_BUDGET_TOLERANCE });
    assert.equal(envelopes.creative, undefined);
    assert.equal(envelopes.voice, undefined);
    assert.deepEqual(allowancesOf(envelopes), { copy: 1.25 });
  });

  it("for a large category the percentage is the larger part of the tolerance", () => {
    assert.equal(categoryEnvelopesOf({ creative: 10 }).creative?.allowanceUsd, 11);
  });

  it("with the tolerance at zero the allowance is the budget, so one cent over it needs an approval", () => {
    const strict = { percent: 0, cents: 0 };
    const voice = categoryEnvelopesOf({ voice: 0.5 }, strict).voice;
    assert.ok(voice);
    assert.equal(voice.allowanceUsd, 0.5);
    assert.equal(positionOf(0.5, voice), "within_target");
    assert.equal(positionOf(0.51, voice), "needs_approval");
  });
});
