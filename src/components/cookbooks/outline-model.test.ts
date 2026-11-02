// The cookbook outline (round 3, K20b2): every step appears in its order with what it waits for; a conditional step is marked; a control
// shows its default in words (a toggle as On or Off).

import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinCookbook } from "../../lib/meridian/cookbooks/builtin/index.ts";
import type { Cookbook } from "../../lib/meridian/cookbooks/schema.ts";
import { outlineOf } from "./outline-model.ts";

function explainer(): Cookbook {
  const cookbook = builtinCookbook("ck_3d_data_explainer");
  assert.ok(cookbook, "the explainer is built in");
  return cookbook;
}

const EXPLAINER = explainer();

test("the outline lists every step in order, with what each step waits for", () => {
  const outline = outlineOf(EXPLAINER);
  assert.equal(outline.steps.length, EXPLAINER.steps.length);
  assert.deepEqual(outline.steps.map((step) => step.id), EXPLAINER.steps.map((step) => step.id));
  const edit = outline.steps.find((step) => step.id === "edit");
  assert.deepEqual(edit?.waitsFor, ["scenes", "captions"], "the edit waits for the scenes and the captions");
});

test("a step that runs only sometimes is marked conditional; one that always runs is not", () => {
  const outline = outlineOf(EXPLAINER);
  assert.equal(outline.steps.find((step) => step.id === "data_room")?.conditional, true);
  assert.equal(outline.steps.find((step) => step.id === "scenes")?.conditional, false);
});

test("controls show their defaults in words: a slider as a number, a toggle as On or Off", () => {
  const outline = outlineOf(EXPLAINER);
  assert.equal(outline.controls.find((control) => control.id === "pace")?.defaultText, "1");
  assert.equal(outline.controls.find((control) => control.id === "data_panels")?.defaultText, "On");
  assert.equal(outline.label, EXPLAINER.label);
  assert.equal(outline.version, EXPLAINER.version);
});
