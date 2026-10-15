import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { alignTokens } from "./align.ts";

describe("the script and transcript alignment (Bible 6.3 step 3)", () => {
  it("has no errors when the transcript says the script", () => {
    const alignment = alignTokens(["a", "b", "c"], ["a", "b", "c"]);
    assert.equal(alignment.wordErrorRate, 0);
    assert.deepEqual(alignment.pairs, [
      { scriptIndex: 0, heardIndex: 0 },
      { scriptIndex: 1, heardIndex: 1 },
      { scriptIndex: 2, heardIndex: 2 },
    ]);
    assert.deepEqual(alignment.deletedScript, []);
  });

  it("counts a substituted word once, and still pairs it in place", () => {
    const alignment = alignTokens(["a", "b", "c"], ["a", "x", "c"]);
    assert.equal(alignment.substitutions, 1);
    assert.equal(alignment.wordErrorRate, 1 / 3);
    assert.equal(alignment.pairs.length, 3);
  });

  it("reports a script word the speech did not say as deleted", () => {
    const alignment = alignTokens(["a", "b", "c"], ["a", "c"]);
    assert.deepEqual(alignment.deletedScript, [1]);
    assert.equal(alignment.wordErrorRate, 1 / 3);
  });

  it("reports a heard word that is not in the script as inserted", () => {
    const alignment = alignTokens(["a", "c"], ["a", "x", "c"]);
    assert.deepEqual(alignment.insertedHeard, [1]);
    assert.equal(alignment.wordErrorRate, 1 / 2);
  });

  it("gives a rate of 1 for an empty script, never 0", () => {
    assert.equal(alignTokens([], ["a"]).wordErrorRate, 1);
  });
});
