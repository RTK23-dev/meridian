import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FACTORY_STAGES, SIGNAL_LABEL, SHARED_CORE } from "./public-model.ts";

describe("the Factory stages shown on the product page", () => {
  test("are the stages AGENTS.md gives, in its order", () => {
    assert.deepEqual(
      FACTORY_STAGES.map((stage) => stage.name),
      ["Source", "Grade", "Angle", "Plan", "Produce", "Gate", "Approve", "Publish", "Measure", "Learn"],
    );
  });

  test("have unique ids and a description each", () => {
    assert.equal(new Set(FACTORY_STAGES.map((stage) => stage.id)).size, FACTORY_STAGES.length);
    for (const stage of FACTORY_STAGES) assert.ok(stage.what.length > 20, `${stage.name} has a description`);
  });

  test("a stage that stops for a person says so in words, from a label the page can show", () => {
    const signalled = FACTORY_STAGES.filter((stage) => stage.signal !== null);
    assert.deepEqual(signalled.map((stage) => stage.name), ["Gate", "Approve", "Publish"]);
    for (const stage of signalled) assert.equal(SIGNAL_LABEL[stage.signal!].length > 0, true);
  });

  test("the shared core lists what the product stores for both ways of creating, with no pipeline of its own", () => {
    assert.ok(SHARED_CORE.includes("Publishing receipts"));
    assert.ok(SHARED_CORE.includes("Measurements"));
    assert.equal(SHARED_CORE.length, new Set(SHARED_CORE).size);
  });
});
