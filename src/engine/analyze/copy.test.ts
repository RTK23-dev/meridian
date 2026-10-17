import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COPY_RUN_WORDS, copiesTranscript, wordTokens } from "./copy.ts";

const transcript = ["Watch", "this", "blender", "crush", "ice"].map((text) => ({ text }));

describe("copy checks (Bible 1 principle 4)", () => {
  it("tokenises lower-case words, dropping punctuation", () => {
    assert.deepEqual(wordTokens("Watch this, blender!"), ["watch", "this", "blender"]);
    assert.deepEqual(wordTokens("Don't stop."), ["don't", "stop"]);
  });

  it("flags a label that repeats three words of the transcript in order, when the run is three", () => {
    assert.equal(copiesTranscript("a shot where they say watch this blender", transcript, 3), true);
  });

  it("the default run is COPY_RUN_WORDS (six, lead decision 2026-10-17): three words in a row are not a copy", () => {
    assert.equal(COPY_RUN_WORDS, 6);
    assert.equal(copiesTranscript("a shot where they say watch this blender", transcript), false);
    const six = ["Watch", "this", "blender", "crush", "ice", "fast", "tap"].map((text) => ({ text }));
    assert.equal(copiesTranscript("they say watch this blender crush ice fast", six), true, "a run of six words is a copy");
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
