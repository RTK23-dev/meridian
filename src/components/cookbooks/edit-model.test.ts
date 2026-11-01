// The cookbook editor's rules (round 3, K20b3): a control takes only a value it allows; a control that does not exist is refused, and so is a
// value of the wrong kind; an instruction must say something and fit the limit.

import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinCookbook } from "../../lib/meridian/cookbooks/builtin/index.ts";
import { applyEdits, INSTRUCTION_MAX_CHARACTERS, instructionEdit, setControlValue } from "./edit-model.ts";

const EXPLAINER = builtinCookbook("ck_3d_data_explainer");
if (EXPLAINER === undefined) throw new Error("the explainer is built in");
const CONTROLS = EXPLAINER.controls;
const VALUES = { pace: 1, data_panels: true };

test("a slider takes a number inside its bounds and refuses one outside them", () => {
  const ok = setControlValue(CONTROLS, VALUES, "pace", 1.2);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.values.pace, 1.2);
  const high = setControlValue(CONTROLS, VALUES, "pace", 9);
  assert.equal(high.ok, false, "a pace above its maximum is refused");
});

test("a toggle takes only a boolean, and the other values stay as they were", () => {
  const off = setControlValue(CONTROLS, VALUES, "data_panels", false);
  assert.equal(off.ok, true);
  if (off.ok) assert.deepEqual(off.values, { pace: 1, data_panels: false });
  assert.equal(setControlValue(CONTROLS, VALUES, "data_panels", "yes").ok, false, "a word is not a toggle value");
});

test("a control that does not exist is refused, with its id named", () => {
  const edit = setControlValue(CONTROLS, VALUES, "no_such_control", 1);
  assert.equal(edit.ok, false);
  if (!edit.ok) assert.match(edit.reason, /no_such_control/);
});

test("an instruction must say something, and fit the limit", () => {
  assert.equal(instructionEdit("   ").ok, false, "a blank instruction is refused");
  assert.equal(instructionEdit("Open on a number.").ok, true);
  assert.equal(instructionEdit("x".repeat(INSTRUCTION_MAX_CHARACTERS)).ok, true, "exactly the limit is allowed");
  const long = instructionEdit("x".repeat(INSTRUCTION_MAX_CHARACTERS + 1));
  assert.equal(long.ok, false);
  if (!long.ok) assert.match(long.reason, /4000/);
});

test("applying edits returns a copy with the new defaults and texts, and leaves the original untouched (K20b3)", () => {
  const before = JSON.stringify(EXPLAINER);
  const edited = applyEdits(EXPLAINER, [
    { kind: "control", id: "pace", value: 1.2 },
    { kind: "instruction", index: 0, text: "Open on a bigger number." },
  ]);
  assert.equal(edited.ok, true);
  if (!edited.ok) return;
  assert.equal(edited.cookbook.controls.find((control) => control.id === "pace")?.default, 1.2);
  assert.equal(edited.cookbook.instructions[0]?.text, "Open on a bigger number.");
  assert.equal(JSON.stringify(EXPLAINER), before, "the original cookbook is not changed");
});

test("one edit that fails stops the set: nothing half-applied is returned, with the reason", () => {
  const bad = applyEdits(EXPLAINER, [
    { kind: "control", id: "pace", value: 1.1 },
    { kind: "control", id: "pace", value: 9 },
  ]);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.reason, /outside what the control allows/);
  assert.equal(applyEdits(EXPLAINER, [{ kind: "instruction", index: 999, text: "x" }]).ok, false, "an instruction that does not exist is refused");
  assert.equal(applyEdits(EXPLAINER, [{ kind: "instruction", index: 0, text: "  " }]).ok, false, "a blank instruction is refused");
});
