import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { copiesTranscript, wordTokens } from "./copy.ts";

const transcript = ["Watch", "this", "blender", "crush", "ice"].map((text) => ({ text }));

describe("copy checks (Bible 1 principle 4)", () => {
  it("tokenises lower-case words, dropping punctuation", () => {
    assert.deepEqual(wordTokens("Watch this, blender!"), ["watch", "this", "blender"]);
    assert.deepEqual(wordTokens("Don't stop."), ["don't", "stop"]);
  });

  it("flags a label that repeats three words of the transcript in order", () => {
    assert.equal(copiesTranscript("a shot where they say watch this blender", transcript), true);
  });

  it("passes a description of the kind of content", () => {
    assert.equal(copiesTranscript("a blender on a kitchen counter", transcript), false);
  });

  it("does not flag two words in a row, nor the same words out of order", () => {
    assert.equal(copiesTranscript("this blender", transcript), false);
    assert.equal(copiesTranscript("blender this watch", transcript), false);
  });

  it("cannot copy from an empty transcript", () => {
    assert.equal(copiesTranscript("watch this blender", []), false);
  });
});
