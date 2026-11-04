import assert from "node:assert/strict";
import test from "node:test";
import { DIRECTION_CODEX_VERSION } from "./codex.ts";
import { directionReport, hookLine, revisionNotes } from "./report.ts";
import { STRONG_SCRIPT, WEAK_SCRIPT } from "./fixtures.ts";

test("the strong fixture is ready: nothing blocks, both floors pass", () => {
  const report = directionReport(STRONG_SCRIPT, { recentHooks: ["The kettle test nobody asked for"] });
  assert.equal(report.codexVersion, DIRECTION_CODEX_VERSION);
  assert.equal(report.blocked, false);
  assert.deepEqual(report.floors, { trust: "pass", originality: "pass" });
  assert.equal(report.counts.block, 0);
  assert.equal(report.counts.warn, 0);
});

test("the weak fixture is blocked, fails the trust floor, and lists blocks before warnings", () => {
  const report = directionReport(WEAK_SCRIPT, { recentHooks: [] });
  assert.equal(report.blocked, true);
  assert.equal(report.floors.trust, "fail", "bait and a loop that never closes fail the trust floor");
  assert.equal(report.floors.originality, "pass");
  const severities = report.findings.map((finding) => finding.severity);
  assert.deepEqual(severities, [...severities].sort((a, b) => ["block", "warn", "info"].indexOf(a) - ["block", "warn", "info"].indexOf(b)));
  const notes = revisionNotes(report, 4);
  assert.equal(notes.length, 4);
  assert.match(notes[0] ?? "", /^1\. \[block\]/);
});

test("a hook that repeats a recent hook of the brand fails the originality floor", () => {
  const report = directionReport(STRONG_SCRIPT, { recentHooks: ["Three mugs, same coffee, two hours!"] });
  assert.equal(report.floors.originality, "fail");
  assert.ok(report.findings.some((finding) => finding.check === "hook_repeat" && finding.severity === "block"));
});

test("without the brand's hooks the originality floor is not checked, never passed", () => {
  assert.equal(directionReport(STRONG_SCRIPT).floors.originality, "not_checked");
});

test("the hook line is the first hook beat's voice, or its on-screen text when it has none", () => {
  assert.equal(hookLine(STRONG_SCRIPT), "Three mugs. Same coffee. Two hours.");
  const silent = { ...STRONG_SCRIPT, beats: [{ ...STRONG_SCRIPT.beats[0]!, voice: "" }, ...STRONG_SCRIPT.beats.slice(1)] };
  assert.equal(hookLine(silent), "Only 1 stays hot");
});
