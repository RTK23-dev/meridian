// The brand frame of a brief (prompt 14): every field is explicit, brand values keep their source, an edit is the person's value and is
// checked, and a stored frame that does not fit its shape is read as not set, never trusted.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyFrameEdit, frameEditProblem, frameFromBrand, parseFrame } from "./frame.ts";

const brand = { tone: "warm and plain", prohibitedClaims: "cures acne", requiredDisclaimers: "results vary", productAllowedClaims: null };

describe("the frame a new brief starts with", () => {
  it("takes the brand's own values with source brand brain, and leaves what the brand does not hold as not set", () => {
    const frame = frameFromBrand(brand);
    assert.deepEqual(frame.voice, { value: "warm and plain", source: "brand brain" });
    assert.deepEqual(frame.prohibitedClaims, { value: "cures acne", source: "brand brain" });
    assert.deepEqual(frame.requiredDisclaimers, { value: "results vary", source: "brand brain" });
    assert.deepEqual(frame.platform, { value: null, source: "not set" }, "no platform is invented");
    assert.deepEqual(frame.budgetUsd, { value: null, source: "not set" }, "no budget is invented");
    assert.deepEqual(frame.allowedClaims, { value: null, source: "not set" }, "a product with no allowed claims is not set");
  });

  it("takes a product's allowed claims with source product, when there are some", () => {
    const frame = frameFromBrand({ ...brand, productAllowedClaims: "washes hands" });
    assert.deepEqual(frame.allowedClaims, { value: "washes hands", source: "product" });
  });

  it("treats a blank brand value as not set, not as a value", () => {
    const frame = frameFromBrand({ ...brand, tone: "   ", prohibitedClaims: "" });
    assert.equal(frame.voice.value, null);
    assert.equal(frame.prohibitedClaims.value, null);
  });
});

describe("an edit to the frame", () => {
  it("is checked before it is applied: a platform too long, a budget that is not positive, too many references, a long criteria", () => {
    assert.match(frameEditProblem({ platform: "x".repeat(121) }) ?? "", /platform/);
    assert.match(frameEditProblem({ budgetUsd: 0 }) ?? "", /positive/);
    assert.match(frameEditProblem({ budgetUsd: Number.NaN }) ?? "", /positive/);
    assert.match(frameEditProblem({ budgetUsd: 1_000_000 }) ?? "", /more than/);
    assert.match(frameEditProblem({ visualReferences: Array.from({ length: 11 }, (_, i) => `ref ${i}`) }) ?? "", /at most 10/);
    assert.match(frameEditProblem({ successCriteria: "y".repeat(501) }) ?? "", /longer than 500/);
    assert.equal(frameEditProblem({ platform: "Instagram Reels", budgetUsd: 250, visualReferences: ["the shot at 0:03"], successCriteria: "Beats the baseline" }), null);
  });

  it("applies the fields it names as the person's value, and keeps every other field and its source", () => {
    const frame = applyFrameEdit(frameFromBrand(brand), { platform: "  Instagram Reels ", budgetUsd: 249.999, visualReferences: [" a ", "", "b"] });
    assert.deepEqual(frame.platform, { value: "Instagram Reels", source: "person" });
    assert.deepEqual(frame.budgetUsd, { value: 250, source: "person" }, "rounded to cents");
    assert.deepEqual(frame.visualReferences, { value: ["a", "b"], source: "person" }, "blank references are dropped");
    assert.deepEqual(frame.voice, { value: "warm and plain", source: "brand brain" }, "the brand's voice is not changed by a person's edit");
  });

  it("an empty value returns the field to not set", () => {
    const edited = applyFrameEdit(applyFrameEdit(frameFromBrand(brand), { platform: "Reels" }), { platform: null });
    assert.deepEqual(edited.platform, { value: null, source: "not set" });
  });
});

describe("reading a stored frame", () => {
  it("reads an older brief, with no frame, as every field not set: nothing is invented for it", () => {
    const frame = parseFrame("{}");
    assert.equal(frame.platform.value, null);
    assert.equal(frame.voice.value, null);
    assert.equal(parseFrame(null).budgetUsd.value, null);
  });

  it("keeps a valid stored field and its source", () => {
    const stored = JSON.stringify({ platform: { value: "Reels", source: "person" }, budgetUsd: { value: 80, source: "person" } });
    const frame = parseFrame(stored);
    assert.deepEqual(frame.platform, { value: "Reels", source: "person" });
    assert.deepEqual(frame.budgetUsd, { value: 80, source: "person" });
  });

  it("does not trust a stored field that does not fit its shape: a wrong type, an unknown source or unparsable text reads as not set", () => {
    const frame = parseFrame(
      JSON.stringify({
        platform: { value: 42, source: "person" },
        budgetUsd: { value: -5, source: "person" },
        voice: { value: "warm", source: "the internet" },
        visualReferences: { value: "not a list", source: "person" },
      }),
    );
    assert.equal(frame.platform.value, null);
    assert.equal(frame.budgetUsd.value, null);
    assert.equal(frame.voice.value, null, "a source that is not known is not trusted");
    assert.equal(frame.visualReferences.value, null);
    assert.equal(parseFrame("{not json").platform.value, null);
  });
});
