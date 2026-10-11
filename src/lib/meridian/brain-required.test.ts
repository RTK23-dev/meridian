import assert from "node:assert/strict";
import test from "node:test";
import {
  BRAIN_FIELDS,
  BRAIN_SECTION_IDS,
  BRAIN_VALUE_KEYS,
  REQUIRED_BRAIN_KEYS,
  brainChanges,
  brainCompleteness,
  emptyBrain,
  reconcileBrain,
  trimmedBrain,
  type BrainKey,
  type BrainValues,
} from "./brain.ts";
import { brainValuesSchema } from "./schemas/brain.ts";

function withWritten(keys: readonly BrainKey[]): BrainValues {
  const brain = emptyBrain();
  for (const key of keys) brain[key] = "written";
  return brain;
}

test("the field list holds the 26 fields the brain screen shows, with unique keys and columns", () => {
  assert.equal(BRAIN_FIELDS.length, 26);
  assert.equal(new Set(BRAIN_FIELDS.map((field) => field.key)).size, 26);
  assert.equal(new Set(BRAIN_FIELDS.map((field) => field.column)).size, 26);
  for (const field of BRAIN_FIELDS) assert.ok(field.label.length > 0, `${field.key} has a label`);
});

test("each section holds the fields the screen has always shown there, and the counts add up to 26", () => {
  const counts = Object.fromEntries(BRAIN_SECTION_IDS.map((id) => [id, BRAIN_FIELDS.filter((field) => field.section === id).length]));
  assert.deepEqual(counts, { identity: 2, positioning: 5, audience: 5, voice: 5, rules: 5, assets: 4 });
  assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), 26);
});

test("the required set is the four fields a generation or gate step reads without a fallback", () => {
  assert.deepEqual([...REQUIRED_BRAIN_KEYS].sort(), ["positioning", "prohibitedClaims", "targetCustomers", "tone"]);
  assert.equal(REQUIRED_BRAIN_KEYS.length, 4);
});

test("the empty brain holds exactly the keys the field list names, plus the automation preference", () => {
  assert.deepEqual(Object.keys(emptyBrain()).sort(), [...BRAIN_VALUE_KEYS].sort());
  assert.equal(emptyBrain().automationLevel, "manual");
  for (const field of BRAIN_FIELDS) assert.equal(emptyBrain()[field.key], "");
});

test("the save validation reads every field of the list, so no field is dropped on save", () => {
  const brain = emptyBrain();
  for (const field of BRAIN_FIELDS) brain[field.key] = `value for ${field.key}`;
  const parsed = brainValuesSchema.parse(brain);
  for (const field of BRAIN_FIELDS) assert.equal(parsed[field.key], `value for ${field.key}`);
});

test("an empty brain is incomplete, and names every required field as missing in form order", () => {
  const score = brainCompleteness(emptyBrain());
  assert.equal(score.filled, 0);
  assert.equal(score.ratio, 0);
  assert.equal(score.requiredFilled, 0);
  assert.equal(score.requiredTotal, 4);
  assert.equal(score.requiredComplete, false);
  assert.deepEqual(score.missingRequired, ["positioning", "targetCustomers", "tone", "prohibitedClaims"]);
});

test("the brain is complete when every required field has content, even with every optional field empty", () => {
  const score = brainCompleteness(withWritten(REQUIRED_BRAIN_KEYS));
  assert.equal(score.requiredComplete, true);
  assert.equal(score.requiredFilled, 4);
  assert.deepEqual(score.missingRequired, []);
  assert.equal(score.filled, 4);
  assert.ok(score.ratio < 1, "the overall count still shows the optional fields as empty");
});

test("a required field holding only spaces is still missing", () => {
  const brain = withWritten(REQUIRED_BRAIN_KEYS);
  brain.tone = "   ";
  const score = brainCompleteness(brain);
  assert.equal(score.requiredComplete, false);
  assert.deepEqual(score.missingRequired, ["tone"]);
  assert.equal(score.requiredFilled, 3);
});

test("filling every optional field does not complete a brain that lacks a required field", () => {
  const optional = BRAIN_FIELDS.filter((field) => !field.required).map((field) => field.key);
  const score = brainCompleteness(withWritten(optional));
  assert.equal(score.filled, 22);
  assert.equal(score.requiredFilled, 0);
  assert.equal(score.requiredComplete, false);
});

test("the required count is the honest number, so a partly filled brain shows how far it is", () => {
  const score = brainCompleteness(withWritten(["positioning", "tone"]));
  assert.equal(score.requiredFilled, 2);
  assert.deepEqual(score.missingRequired, ["targetCustomers", "prohibitedClaims"]);
});

test("a save sends only the trimmed fields that differ from the saved brain", () => {
  const saved = withWritten(["positioning"]);
  const next = { ...saved, positioning: "written ", tone: "  dry  " };
  assert.deepEqual(brainChanges(next, saved), { tone: "dry" });
});

test("a form that matches the saved brain sends nothing", () => {
  const saved = withWritten(["positioning", "tone"]);
  assert.deepEqual(brainChanges({ ...saved, tone: "written " }, saved), {});
});

test("the automation preference is compared with the fields", () => {
  const saved = emptyBrain();
  assert.deepEqual(brainChanges({ ...saved, automationLevel: "assisted" }, saved), { automationLevel: "assisted" });
});

test("trimmedBrain trims every text field, so a stored value with a stray space is not an edit", () => {
  const stored = { ...emptyBrain(), tone: "dry " };
  assert.equal(trimmedBrain(stored).tone, "dry");
  assert.deepEqual(brainChanges({ ...emptyBrain(), tone: "dry" }, stored), {});
});

test("a form that holds a value the person did not change takes the saved value", () => {
  const previous = withWritten(["tone"]);
  const server = { ...previous, tone: "warm" };
  const form = { ...previous };
  assert.equal(reconcileBrain(form, previous, server).tone, "warm");
});

test("a field the person edited keeps their value after the saved brain moves", () => {
  const previous = withWritten(["tone"]);
  const server = { ...previous, tone: "warm", positioning: "from another editor" };
  const form = { ...previous, positioning: "my edit" };
  const merged = reconcileBrain(form, previous, server);
  assert.equal(merged.positioning, "my edit");
  assert.equal(merged.tone, "warm");
});

test("a stale form cannot undo another editor's change: the send holds only the field the person edited", () => {
  // Loaded with tone "written". Another editor saves tone "warm" meanwhile. This form still holds the loaded tone.
  const loaded = withWritten(["tone", "positioning"]);
  const formOfThisEditor = { ...loaded, positioning: "my edit" };
  assert.deepEqual(brainChanges(formOfThisEditor, loaded), { positioning: "my edit" });
});
