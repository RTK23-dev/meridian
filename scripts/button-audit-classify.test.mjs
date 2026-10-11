import assert from "node:assert/strict";
import test from "node:test";
import { FAILING_STATUSES, classifyControl, summarizeRun, summarizeScreen } from "./button-audit-classify.mjs";

const visible = { visible: true, disabled: false };

test("an enabled control with an onClick handler is an action", () => {
  assert.equal(classifyControl({ ...visible, handlers: ["onClick"] }).status, "action");
});

test("a Radix tab or menu trigger counts as a target through its pointer handler", () => {
  assert.equal(classifyControl({ ...visible, handlers: ["onMouseDown", "onKeyDown", "onFocus"] }).status, "action");
  assert.equal(classifyControl({ ...visible, handlers: ["onPointerDown"] }).status, "action");
  assert.equal(classifyControl({ ...visible, handlers: ["onSelect"] }).status, "action");
});

test("a submit button in a form that has a submit handler is a submit target", () => {
  assert.equal(classifyControl({ ...visible, handlers: [], submitsForm: true, formHasSubmitHandler: true }).status, "submit");
});

test("a submit button in a form with no submit handler has no target, because a native submit would reload the page", () => {
  assert.equal(classifyControl({ ...visible, handlers: [], submitsForm: true, formHasSubmitHandler: false }).status, "no_target");
});

test("an enabled control with no handler at all has no click target", () => {
  assert.equal(classifyControl({ ...visible, handlers: ["onFocus", "onBlur"] }).status, "no_target");
  assert.equal(classifyControl({ ...visible, handlers: [] }).status, "no_target");
});

test("a link is its own target", () => {
  assert.equal(classifyControl({ ...visible, handlers: [], isLink: true }).status, "link");
});

test("a disabled control with its reason in visible text is accepted", () => {
  assert.equal(classifyControl({ visible: true, disabled: true, reasonText: "Type a niche to queue a run.", handlers: ["onClick"] }).status, "disabled_reason");
});

test("a disabled control with no reason text fails, even when it has a handler", () => {
  assert.equal(classifyControl({ visible: true, disabled: true, reasonText: "   ", handlers: ["onClick"] }).status, "disabled_no_reason");
  assert.equal(classifyControl({ visible: true, disabled: true, reasonText: null, handlers: [] }).status, "disabled_no_reason");
});

test("a control that is not visible is recorded as hidden and never fails the audit", () => {
  assert.equal(classifyControl({ visible: false, disabled: false, handlers: [] }).status, "hidden");
  assert.equal(FAILING_STATUSES.includes("hidden"), false);
});

test("only the two failing statuses fail the audit", () => {
  assert.deepEqual([...FAILING_STATUSES].sort(), ["disabled_no_reason", "no_target"]);
});

test("a screen reports counts per status and lists the controls that fail", () => {
  const screen = summarizeScreen("/brands/x/library", [
    { name: "Save", status: "action" },
    { name: "Ghost", status: "no_target", section: "Paused publishing" },
    { name: "Export", status: "disabled_no_reason" },
    { name: "Hidden", status: "hidden" },
  ]);
  assert.equal(screen.total, 4);
  assert.equal(screen.counts.action, 1);
  assert.equal(screen.counts.no_target, 1);
  assert.deepEqual(screen.failing.map((control) => control.name), ["Ghost", "Export"]);
  assert.equal(screen.error, null);
});

test("a disabled control with its reason is listed with that reason, so the reason can be read in the report", () => {
  const screen = summarizeScreen("/brands/x/factory", [
    { name: "Queue factory run", status: "disabled_reason", reasonText: "Type a niche to queue a run." },
    { name: "Save", status: "action" },
  ]);
  assert.deepEqual(screen.reasons, [{ name: "Queue factory run", reason: "Type a niche to queue a run." }]);
  assert.deepEqual(summarizeRun([screen]).disabledWithReason, [{ screen: "/brands/x/factory", name: "Queue factory run", reason: "Type a niche to queue a run." }]);
});

test("a screen with no controls at all is an error, so an empty visit cannot pass", () => {
  const screen = summarizeScreen("/brands/x/index", []);
  assert.match(screen.error, /no buttons or links/);
});

test("a screen that failed to load keeps its load error", () => {
  const screen = summarizeScreen("/brands/x/studio", [], "navigation timed out");
  assert.equal(screen.error, "navigation timed out");
});

test("the run is ok only when every screen loaded, showed controls, and no control fails", () => {
  const clean = summarizeScreen("a", [{ name: "Save", status: "action" }]);
  const dirty = summarizeScreen("b", [{ name: "Ghost", status: "no_target" }]);
  const broken = summarizeScreen("c", [], "timed out");
  assert.equal(summarizeRun([clean]).ok, true);
  assert.equal(summarizeRun([clean]).controlsChecked, 1);
  assert.equal(summarizeRun([clean, dirty]).ok, false);
  assert.equal(summarizeRun([clean, dirty]).failing[0].screen, "b");
  assert.equal(summarizeRun([clean, broken]).ok, false);
  assert.deepEqual(summarizeRun([clean, broken]).screenErrors, [{ screen: "c", error: "timed out" }]);
  assert.equal(summarizeRun([]).ok, false, "a run that visited nothing does not pass");
});
