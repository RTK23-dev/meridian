import assert from "node:assert/strict";
import test from "node:test";
import { factFindings, numbersIn } from "./facts.ts";
import { directionReport } from "./report.ts";
import { STRONG_SCRIPT } from "./fixtures.ts";

const BRIEF = "We tested three mugs for two hours. Coffee poured at 90 degrees; the double-wall mug held 61 degrees. Only 1 stayed hot.";

test("numbers are read as digits and as English number words, with separators dropped", () => {
  assert.deepEqual([...numbersIn("1,000 cups, 2.5 hours, three mugs, 61°")].sort(), ["1000", "2.5", "3", "61"]);
  assert.deepEqual([...numbersIn("sixty one degrees, ninety-two percent, forty")].sort(), ["40", "61", "92"]);
  assert.deepEqual([...numbersIn("no numbers here")], []);
});

test("every number in the strong script is in the brief, so nothing is flagged", () => {
  assert.deepEqual(factFindings(STRONG_SCRIPT, { durationMs: 20_000, facts: BRIEF }), []);
});

test("a number the brief does not give is a warning on its beat; without the brief the check is not run", () => {
  const script = { ...STRONG_SCRIPT, beats: [{ ...STRONG_SCRIPT.beats[0]!, voice: "Three mugs. 97% of people pick the wrong one." }, ...STRONG_SCRIPT.beats.slice(1)] };
  const findings = factFindings(script, { durationMs: 20_000, facts: BRIEF });
  assert.deepEqual(findings.map((finding) => [finding.check, finding.beatId, finding.severity]), [["unsourced_number", "b1", "warn"]]);
  assert.match(findings[0]?.message ?? "", /97/);
  assert.deepEqual(factFindings(script, { durationMs: 20_000 }), []);
});

test("a forbidden term anywhere in a beat, its picture included, is refused and fails the trust floor", () => {
  const findings = factFindings(STRONG_SCRIPT, { durationMs: 20_000, forbidden: ["Thermo King", "kettle"] });
  assert.deepEqual(findings, []);
  const named = factFindings(STRONG_SCRIPT, { durationMs: 20_000, forbidden: ["timer"] });
  assert.deepEqual(named.map((finding) => [finding.check, finding.beatId]), [["forbidden_term", "b1"]], "the picture says 'a kitchen timer starts'");
  const report = directionReport(STRONG_SCRIPT, { forbidden: ["timer"], recentHooks: [] });
  assert.equal(report.floors.trust, "fail");
});

test("a script over its length limit is refused", () => {
  const report = directionReport(STRONG_SCRIPT, { maxDurationMs: 8000, recentHooks: [] });
  assert.ok(report.findings.some((finding) => finding.check === "max_duration" && finding.severity === "block"));
  assert.equal(report.blocked, true);
});
