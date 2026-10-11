import assert from "node:assert/strict";
import test from "node:test";
import { BRAIN_FIELDS, emptyBrain } from "../../lib/meridian/brain.ts";
import { BRAIN_SECTIONS, fieldLabel, sectionAnchor, sectionProgress } from "./brain-sections.ts";

test("the sections are the six the screen shows, in order", () => {
  assert.deepEqual(BRAIN_SECTIONS.map((section) => section.label), ["Identity", "Positioning", "Audience", "Voice", "Rules", "Assets"]);
});

test("every field is shown in exactly one section", () => {
  const shown = BRAIN_SECTIONS.flatMap((section) => section.keys);
  assert.equal(shown.length, BRAIN_FIELDS.length);
  assert.deepEqual([...shown].sort(), BRAIN_FIELDS.map((field) => field.key).sort());
});

test("the section counts match the screen: 2, 5, 5, 5, 5 and 4 fields", () => {
  assert.deepEqual(BRAIN_SECTIONS.map((section) => section.keys.length), [2, 5, 5, 5, 5, 4]);
});

test("a section counts its fields with content, and whitespace is empty", () => {
  const brain = emptyBrain();
  brain.positioning = "Plain soap";
  brain.valueProposition = "   ";
  const positioning = BRAIN_SECTIONS.find((section) => section.id === "positioning");
  assert.ok(positioning);
  assert.deepEqual(sectionProgress(positioning.keys, brain), { filled: 1, total: 5 });
});

test("section anchors and field labels come from the same list", () => {
  assert.equal(sectionAnchor("audience"), "brain-audience");
  assert.equal(fieldLabel("targetCustomers"), "Target customers");
  assert.equal(fieldLabel("notAField"), null);
});
