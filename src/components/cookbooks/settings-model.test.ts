// The settings panel's rows (K17): one per control, in order; a value of the wrong kind or out of range falls back to the default; each
// kind carries what the panel needs to draw it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { threeDDataExplainerCookbook } from "../../lib/meridian/cookbooks/builtin/three-d-data-explainer.ts";
import { currentValue, settingRows } from "./settings-model.ts";

test("one row per control, in the cookbook's order, each with its kind and its value", () => {
  const rows = settingRows(threeDDataExplainerCookbook, {});
  assert.equal(rows.length, threeDDataExplainerCookbook.controls.length);
  assert.deepEqual(rows.map((row) => row.id), threeDDataExplainerCookbook.controls.map((control) => control.id));
  const pace = rows.find((row) => row.id === "pace");
  assert.equal(pace?.kind, "slider");
  if (pace?.kind === "slider") assert.deepEqual([pace.min, pace.max, pace.value], [0.5, 1.5, 1]);
});

test("a value of the wrong kind, or out of its slider's range, falls back to the default", () => {
  const rows = settingRows(threeDDataExplainerCookbook, { pace: 9, data_panels: "yes" });
  const pace = rows.find((row) => row.id === "pace");
  const panels = rows.find((row) => row.id === "data_panels");
  assert.equal(pace?.kind === "slider" && pace.value, 1);
  assert.equal(panels?.kind === "toggle" && panels.value, true);
});

test("a select shows its options, and a value that is not an option is the default", () => {
  const rows = settingRows(threeDDataExplainerCookbook, { voice_way: "not-an-option" });
  const voice = rows.find((row) => row.id === "voice_way");
  assert.equal(voice?.kind, "select");
  if (voice?.kind === "select") {
    assert.equal(voice.value, "none");
    assert.ok(voice.options.some((option) => option.value === "tts"));
  }
});

test("the current value is the person's when it fits, and the default otherwise", () => {
  const control = threeDDataExplainerCookbook.controls.find((candidate) => candidate.id === "pace");
  assert.ok(control);
  if (control) {
    assert.equal(currentValue(control, { pace: 1.2 }), 1.2);
    assert.equal(currentValue(control, {}), control.default);
  }
});
