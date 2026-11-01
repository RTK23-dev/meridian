import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUDGET_CATEGORIES, categoryBudgetsOf, categoryOf, categorySpentOf } from "./categories.ts";
import { NODE_KINDS, type NodeKind } from "./contracts.ts";
import { KIND_CATALOG } from "./validate.ts";

describe("budget categories (owner direction 2026-10-23, D3)", () => {
  it("a step has a category exactly when it makes a model call, so the three categories cover every paid step", () => {
    for (const kind of NODE_KINDS) {
      assert.equal(categoryOf(kind) !== null, KIND_CATALOG[kind] !== undefined, `${kind}: a category if and only if the step is paid`);
    }
    assert.deepEqual(BUDGET_CATEGORIES, ["copy", "creative", "voice"]);
  });

  it("copy is the text steps, creative the image and video steps, and voice the speech steps", () => {
    assert.equal(categoryOf("analysis"), "copy");
    assert.equal(categoryOf("script"), "copy");
    for (const kind of ["visual", "video", "avatar"] as const) assert.equal(categoryOf(kind), "creative");
    assert.equal(categoryOf("voice"), "voice");
    for (const kind of ["reference", "edit", "compose", "render"] as const) assert.equal(categoryOf(kind), null);
  });

  it("a brief sets a category only when it names one, so a category it leaves unset is absent (delegated under the total)", () => {
    assert.deepEqual(categoryBudgetsOf({}), {});
    assert.deepEqual(categoryBudgetsOf({ copyBudgetUsd: 0.5, voiceBudgetUsd: 2 }), { copy: 0.5, voice: 2 });
  });

  it("a category's spend is its stored outputs plus the holds of its failed steps; a step with no category is in none", () => {
    const nodes: Array<{ id: string; kind: NodeKind }> = [
      { id: "a1", kind: "analysis" },
      { id: "v1", kind: "visual" },
      { id: "r1", kind: "reference" },
    ];
    const holds = new Map([
      ["a1", 0.2],
      ["v1", 0.4],
      ["r1", 0.1],
      ["removed", 0.9],
    ]);
    assert.deepEqual(categorySpentOf(nodes, { copy: 0.3 }, holds), { copy: 0.5, creative: 0.4 });
  });
});
