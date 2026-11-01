// The cookbook editor's rules (round 3, K20b3): a control takes only a value it allows; a control that does not exist is refused, and so is a
// value of the wrong kind; an instruction must say something and fit the limit.

import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinCookbook } from "../../lib/meridian/cookbooks/builtin/index.ts";
import type { Cookbook } from "../../lib/meridian/cookbooks/schema.ts";
import {
  applyEdits,
  COPY_PREFIX,
  editsFromDraft,
  INSTRUCTION_MAX_CHARACTERS,
  instructionEdit,
  planSave,
  runSavePlan,
  setControlValue,
  STEP_LABEL_MAX_CHARACTERS,
  stepLabelEdit,
  stepParamValue,
  type CookbookDraft,
  type SaveCalls,
} from "./edit-model.ts";

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

test("a workspace cookbook is saved as its next version in one step (K20b3b part 2)", () => {
  const edited = applyEdits(EXPLAINER, [{ kind: "control", id: "pace", value: 1.2 }]);
  if (!edited.ok) throw new Error("the edit should apply");
  const steps = planSave({ source: "workspace", original: EXPLAINER, edited: edited.cookbook, newCopyId: "ck_my_unused" });
  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.action, "save");
});

test("a built-in cookbook is copied first, then the edited copy is saved under the copy's id", () => {
  const edited = applyEdits(EXPLAINER, [{ kind: "control", id: "pace", value: 1.2 }]);
  if (!edited.ok) throw new Error("the edit should apply");
  const steps = planSave({ source: "builtin", original: EXPLAINER, edited: edited.cookbook, newCopyId: `${COPY_PREFIX}abc123` });
  assert.equal(steps.length, 2);
  assert.deepEqual(steps[0], { action: "fork", from: { cookbookId: "ck_3d_data_explainer", version: EXPLAINER.version }, newCookbookId: `${COPY_PREFIX}abc123` });
  const save = steps[1];
  assert.equal(save?.action, "save");
  if (save?.action === "save") assert.equal(save.cookbook.cookbookId, `${COPY_PREFIX}abc123`);
});

test("a built-in is never saved under its own id, and a copy id must carry the copy prefix", () => {
  const edited = applyEdits(EXPLAINER, []);
  if (!edited.ok) throw new Error("no edits apply");
  assert.throws(() => planSave({ source: "builtin", original: EXPLAINER, edited: edited.cookbook, newCopyId: "ck_3d_data_explainer" }), /copy id/);
});

test("the copy is saved as a workspace cookbook, never as a built-in", () => {
  const edited = applyEdits(EXPLAINER, []);
  if (!edited.ok) throw new Error("no edits apply");
  const steps = planSave({ source: "builtin", original: EXPLAINER, edited: edited.cookbook, newCopyId: `${COPY_PREFIX}xyz` });
  const save = steps[1];
  if (save?.action !== "save") throw new Error("the second step saves");
  assert.equal(save.cookbook.scope, "workspace");
});

function recordingCalls(outcomes: { fork?: { ok: boolean; reason?: string }; save?: { ok: boolean; reason?: string } }) {
  const log: string[] = [];
  const calls: SaveCalls = {
    fork: async () => {
      log.push("fork");
      return outcomes.fork ?? { ok: true };
    },
    save: async () => {
      log.push("save");
      return outcomes.save ?? { ok: true };
    },
  };
  return { calls, log };
}

test("a save plan runs in order and reports success when every call succeeds", async () => {
  const edited = applyEdits(EXPLAINER, []);
  if (!edited.ok) throw new Error("no edits apply");
  const steps = planSave({ source: "builtin", original: EXPLAINER, edited: edited.cookbook, newCopyId: `${COPY_PREFIX}ok` });
  const { calls, log } = recordingCalls({});
  assert.deepEqual(await runSavePlan("brand_1", steps, calls), { ok: true });
  assert.deepEqual(log, ["fork", "save"]);
});

test("a failed fork stops the plan: nothing is saved, and the reason is kept", async () => {
  const edited = applyEdits(EXPLAINER, []);
  if (!edited.ok) throw new Error("no edits apply");
  const steps = planSave({ source: "builtin", original: EXPLAINER, edited: edited.cookbook, newCopyId: `${COPY_PREFIX}f` });
  const { calls, log } = recordingCalls({ fork: { ok: false, reason: "no permission" } });
  assert.deepEqual(await runSavePlan("brand_1", steps, calls), { ok: false, reason: "no permission" });
  assert.deepEqual(log, ["fork"]);
});

test("a refused edit after the copy was made says the copy exists with the cookbook's own text", async () => {
  const edited = applyEdits(EXPLAINER, []);
  if (!edited.ok) throw new Error("no edits apply");
  const steps = planSave({ source: "builtin", original: EXPLAINER, edited: edited.cookbook, newCopyId: `${COPY_PREFIX}s` });
  const { calls } = recordingCalls({ save: { ok: false, reason: "a rule broke" } });
  const outcome = await runSavePlan("brand_1", steps, calls);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.reason, /The copy was made with the cookbook's own text, but the edits were not saved: a rule broke/);
});

test("a step's label is trimmed, and a blank label or one over the limit is refused (K20c)", () => {
  assert.deepEqual(stepLabelEdit("  Write the hook  "), { ok: true, label: "Write the hook" });
  assert.equal(stepLabelEdit("   ").ok, false, "a blank label is refused");
  assert.equal(stepLabelEdit("x".repeat(STEP_LABEL_MAX_CHARACTERS)).ok, true, "exactly the limit is allowed");
  const long = stepLabelEdit("x".repeat(STEP_LABEL_MAX_CHARACTERS + 1));
  assert.equal(long.ok, false);
  if (!long.ok) assert.match(long.reason, /at most 80 characters/);
});

test("a step keeps its settings: a known setting takes a value of its kind, and an unknown key or another kind is refused (K20c)", () => {
  const script = EXPLAINER.steps.find((step) => step.id === "script");
  if (script === undefined) throw new Error("the explainer has a script step");
  assert.deepEqual(stepParamValue(script, "beats", 10), { ok: true, value: 10 });
  const kind = stepParamValue(script, "beats", "ten");
  assert.equal(kind.ok, false, "a word is not a number setting");
  if (!kind.ok) assert.match(kind.reason, /beats takes a number, not a string/);
  assert.equal(stepParamValue(script, "beats", Number.NaN).ok, false, "a number that is not finite is refused");
  const unknown = stepParamValue(script, "no_such_setting", 1);
  assert.equal(unknown.ok, false, "a setting the step does not have is refused");
  if (!unknown.ok) assert.match(unknown.reason, /no setting no_such_setting/);
});

test("applying step edits changes the copy's label and setting, leaves the original alone, and refuses a step that does not exist (K20c)", () => {
  const before = JSON.stringify(EXPLAINER);
  const index = EXPLAINER.steps.findIndex((step) => step.id === "script");
  assert.ok(index >= 0, "the explainer has a script step");
  const edited = applyEdits(EXPLAINER, [
    { kind: "step-label", index, label: "Write the hook" },
    { kind: "step-param", index, key: "beats", value: 10 },
  ]);
  assert.equal(edited.ok, true);
  if (!edited.ok) return;
  assert.equal(edited.cookbook.steps[index]?.label, "Write the hook");
  assert.equal(edited.cookbook.steps[index]?.params.beats, 10);
  assert.equal(JSON.stringify(EXPLAINER), before, "the original cookbook is not changed");
  assert.equal(applyEdits(EXPLAINER, [{ kind: "step-param", index: 999, key: "beats", value: 10 }]).ok, false, "a step that does not exist is refused");
  assert.equal(applyEdits(EXPLAINER, [{ kind: "step-label", index, label: " " }]).ok, false, "a blank step label is refused");
});

function draftOf(cookbook: Cookbook): CookbookDraft {
  return {
    values: Object.fromEntries(cookbook.controls.map((control) => [control.id, control.default])),
    texts: cookbook.instructions.map((instruction) => instruction.text),
    steps: cookbook.steps.map((step) => ({ label: step.label, params: { ...step.params } })),
  };
}

test("an untouched draft makes no edits, so saving it changes nothing (K20d)", () => {
  assert.deepEqual(editsFromDraft(EXPLAINER, draftOf(EXPLAINER)), []);
});

test("each changed field becomes one edit: a control, an instruction, a step's label and a step's setting (K20d)", () => {
  const index = EXPLAINER.steps.findIndex((step) => step.id === "script");
  assert.ok(index >= 0, "the explainer has a script step");
  const draft = draftOf(EXPLAINER);
  draft.values = { ...draft.values, pace: 1.2 };
  draft.texts = draft.texts.map((text, position) => (position === 0 ? "Open on a bigger number." : text));
  draft.steps = draft.steps.map((step, position) => (position === index ? { label: "Write the hook", params: { ...step.params, beats: 10 } } : step));
  assert.deepEqual(editsFromDraft(EXPLAINER, draft), [
    { kind: "control", id: "pace", value: 1.2 },
    { kind: "instruction", index: 0, text: "Open on a bigger number." },
    { kind: "step-label", index, label: "Write the hook" },
    { kind: "step-param", index, key: "beats", value: 10 },
  ]);
});

test("the edits a draft makes are the ones the rules accept: applying them gives the copy the draft's step text (K20d)", () => {
  const index = EXPLAINER.steps.findIndex((step) => step.id === "script");
  const draft = draftOf(EXPLAINER);
  draft.steps = draft.steps.map((step, position) => (position === index ? { label: "  Write the hook  ", params: { ...step.params, beats: 10 } } : step));
  const applied = applyEdits(EXPLAINER, editsFromDraft(EXPLAINER, draft));
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  assert.equal(applied.cookbook.steps[index]?.label, "Write the hook", "the label is trimmed, as the rule says");
  assert.equal(applied.cookbook.steps[index]?.params.beats, 10);
});
