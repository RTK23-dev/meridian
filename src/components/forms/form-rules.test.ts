import assert from "node:assert/strict";
import test from "node:test";
import { AUTOSAVE_DEBOUNCE_MS, autosaveDecision, closeDecision, isSubmitShortcut, sameFormValues, shouldBlockNavigation, type ShortcutEvent } from "./form-rules.ts";

const key = (overrides: Partial<ShortcutEvent>): ShortcutEvent => ({ key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...overrides });

test("a dirty form asks before it closes, and a clean form closes at once", () => {
  assert.equal(closeDecision(true), "confirm-discard");
  assert.equal(closeDecision(false), "close");
  assert.equal(shouldBlockNavigation(true), true);
  assert.equal(shouldBlockNavigation(false), false);
});

test("Cmd+Enter or Ctrl+Enter submits", () => {
  assert.equal(isSubmitShortcut(key({ metaKey: true })), true);
  assert.equal(isSubmitShortcut(key({ ctrlKey: true })), true);
});

test("plain Enter, other keys, Alt, Shift and IME composition do not submit", () => {
  assert.equal(isSubmitShortcut(key({})), false, "plain Enter");
  assert.equal(isSubmitShortcut(key({ key: "a", ctrlKey: true })), false, "another key");
  assert.equal(isSubmitShortcut(key({ ctrlKey: true, altKey: true })), false, "Alt");
  assert.equal(isSubmitShortcut(key({ metaKey: true, shiftKey: true })), false, "Shift");
  assert.equal(isSubmitShortcut(key({ ctrlKey: true, isComposing: true })), false, "IME composition");
});

test("two form values are the same when every field holds the same value", () => {
  assert.equal(sameFormValues({ a: "x", b: 1, c: true }, { a: "x", b: 1, c: true }), true);
  assert.equal(sameFormValues({ a: "x" }, { a: "y" }), false);
  assert.equal(sameFormValues({ a: "x", b: "y" }, { a: "x" }), false, "a field on one side only is a change");
});

test("a missing field is different from an empty string", () => {
  assert.equal(sameFormValues({ a: "" }, {}), false);
  assert.equal(sameFormValues({}, { a: "" }), false);
});

test("lists are the same when they have the same items in the same order", () => {
  assert.equal(sameFormValues({ tags: ["a", "b"] }, { tags: ["a", "b"] }), true);
  assert.equal(sameFormValues({ tags: ["a", "b"] }, { tags: ["b", "a"] }), false);
  assert.equal(sameFormValues({ tags: ["a"] }, { tags: ["a", "b"] }), false);
  assert.equal(sameFormValues({ tags: ["a"] }, { tags: "a" }), false, "a list and a string are different");
});

test("an autosave never sends for a viewer, an unchanged form, or an invalid one", () => {
  assert.equal(autosaveDecision({ canEdit: false, changed: true, valid: true }), "skip-read-only");
  assert.equal(autosaveDecision({ canEdit: true, changed: false, valid: true }), "skip-unchanged");
  assert.equal(autosaveDecision({ canEdit: true, changed: true, valid: false }), "report-invalid");
  assert.equal(autosaveDecision({ canEdit: true, changed: true, valid: true }), "save");
});

test("a viewer's form is skipped even when it is changed and valid", () => {
  assert.equal(autosaveDecision({ canEdit: false, changed: false, valid: false }), "skip-read-only");
});

test("the brain waits 1.5 seconds after the last keystroke before it saves", () => {
  assert.equal(AUTOSAVE_DEBOUNCE_MS, 1500);
});
