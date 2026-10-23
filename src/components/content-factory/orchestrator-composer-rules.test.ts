import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { missingFields, optionalBudget, type ComposerFields } from "./orchestrator-presentation.ts";

const complete: ComposerFields = {
  brandId: "brand_1",
  title: "Launch",
  goal: "A video",
  format: "9:16, 20 seconds",
  budget: "2",
  storedModel: "anthropic/claude-haiku-5.5",
};

describe("the composer's required fields (owner direction 2026-10-23)", () => {
  it("a complete brief in format mode needs nothing more", () => {
    assert.deepEqual(missingFields(complete), []);
  });

  it("with the person's own inputs, the inputs are required and the format is not", () => {
    assert.deepEqual(missingFields({ ...complete, format: "", mode: "own", userInputs: "" }), ["your inputs"]);
    assert.deepEqual(missingFields({ ...complete, format: "", mode: "own", userInputs: "two offers and a logo" }), []);
  });

  it("in format mode a format is required, even when inputs are given", () => {
    assert.deepEqual(missingFields({ ...complete, format: "", userInputs: "two offers" }), ["the format"]);
  });

  it("an empty category budget is unset and needs nothing; one out of range is named", () => {
    assert.deepEqual(missingFields({ ...complete, copyBudget: "", creativeBudget: "", voiceBudget: "" }), []);
    assert.deepEqual(missingFields({ ...complete, copyBudget: "0" }), ["a copy budget from $0.01 to $1,000, or left empty"]);
    assert.deepEqual(missingFields({ ...complete, voiceBudget: "abc" }), ["a voice budget from $0.01 to $1,000, or left empty"]);
  });
});

describe("the category budgets as the composer sends them", () => {
  it("an empty budget is left out, so the orchestrator splits that category", () => {
    assert.equal(optionalBudget(undefined), undefined);
    assert.equal(optionalBudget(""), undefined);
    assert.equal(optionalBudget("  "), undefined);
  });

  it("a budget in range is sent as a number, and one out of range is not sent", () => {
    assert.equal(optionalBudget("0.5"), 0.5);
    assert.equal(optionalBudget("1000"), 1000);
    assert.equal(optionalBudget("0"), undefined);
  });
});
