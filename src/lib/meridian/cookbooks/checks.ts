// Checking an output against a cookbook's targets (round 3, K22). The measures are the ones compare.ts reports (the media functions on the
// rendered file). Each check is one of: pass (within the tolerance), near (within twice the tolerance), miss (further), or unknown (the measure
// could not be read). Unknown is never a pass: a measure that is not there is not a value, so it is never called right (CLAUDE.md rule 1).

import type { Check } from "./schema.ts";

/** The measured values of one video, by measure name. null (or a missing key) is a measure that could not be read. */
export type Measures = Readonly<Record<string, number | null | undefined>>;

export type CheckOutcome = {
  measure: Check["measure"];
  target: number;
  tolerance: number;
  value: number | null;
  verdict: "pass" | "near" | "miss" | "unknown";
};

export function checkOutputs(checks: readonly Check[], measures: Measures): CheckOutcome[] {
  return checks.map((check) => {
    const raw = measures[check.measure];
    const value = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    if (value === null) return { measure: check.measure, target: check.target, tolerance: check.tolerance, value: null, verdict: "unknown" };
    const distance = Math.abs(value - check.target);
    const verdict = distance <= check.tolerance ? "pass" : distance <= 2 * check.tolerance ? "near" : "miss";
    return { measure: check.measure, target: check.target, tolerance: check.tolerance, value, verdict };
  });
}

/** One line per check, for the run's log and the owner's report. */
export function reportLines(outcomes: readonly CheckOutcome[]): string[] {
  return outcomes.map((outcome) => {
    const value = outcome.value === null ? "not measured" : String(Math.round(outcome.value * 1000) / 1000);
    return `${outcome.measure}: ${value} against ${outcome.target} (+/- ${outcome.tolerance}): ${outcome.verdict}`;
  });
}
