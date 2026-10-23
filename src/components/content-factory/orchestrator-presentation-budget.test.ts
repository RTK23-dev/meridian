import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BUDGET_PAUSE_HEADING,
  CEILING,
  actorNameOf,
  approvalHint,
  approvalText,
  approvalsNewestFirst,
  brandFamiliesAfter,
  brandFamilyRows,
  budgetPauseDetail,
  budgetPauseHeading,
  ceilingText,
  familiesFromText,
  measuredAverageText,
  normalizeFamily,
  parseCeiling,
  pauseCategoryOf,
  withFamily,
  workspaceFamilyRows,
} from "./orchestrator-presentation.ts";

const TOTAL_REASON =
  "budget reached, project not finished: the next step's hold of $0.4000 would take the spend past the $2.0000 budget (committed $1.8000)";
const COPY_REASON =
  "copy budget reached, project not finished: the next step's hold of $0.2000 would take the spend past the $0.5000 copy budget (committed $0.4000)";

test("the pause alert has the budget heading and the run's own reason, without the heading's opening said twice", () => {
  assert.equal(BUDGET_PAUSE_HEADING, "Budget reached, project not finished");
  assert.equal(
    budgetPauseDetail(TOTAL_REASON),
    "The next step's hold of $0.4000 would take the spend past the $2.0000 budget (committed $1.8000)",
  );
  assert.equal(budgetPauseDetail("budget reached, project not finished"), "The run stopped at its budget line.");
  // A category's reason opens with the category's line, which the heading names, so the detail starts after that opening.
  assert.equal(
    budgetPauseDetail(COPY_REASON),
    "The next step's hold of $0.2000 would take the spend past the $0.5000 copy budget (committed $0.4000)",
  );
  assert.equal(budgetPauseDetail(null), "No reason was recorded for this pause.");
  assert.equal(budgetPauseDetail("   "), "No reason was recorded for this pause.", "a blank reason is not shown as a guess");
});

test("a pause names the line it stopped at, read from the pause event's reason: the total line, or a category", () => {
  assert.equal(pauseCategoryOf(TOTAL_REASON), null);
  assert.equal(pauseCategoryOf(COPY_REASON), "copy");
  assert.equal(pauseCategoryOf("creative budget reached, project not finished: the next step's hold"), "creative");
  assert.equal(pauseCategoryOf("Voice budget reached, project not finished"), "voice", "the match ignores case");
  assert.equal(pauseCategoryOf("the run stopped for another reason"), null);
  assert.equal(pauseCategoryOf(null), null);
  assert.equal(budgetPauseHeading(null), "Budget reached, project not finished");
  assert.equal(budgetPauseHeading("copy"), "Copy budget reached, project not finished");
  assert.equal(budgetPauseHeading("voice"), "Voice budget reached, project not finished");
  assert.equal(budgetPauseDetail("creative budget reached, project not finished"), "The run stopped at its budget line.");
});

test("the approval line says what the amount does, for the total line and for a category's line", () => {
  const totalStops = "The run stops at the budget line of $2.00. The approved budget must be above it.";
  assert.equal(approvalHint({ category: null, budgetUsd: 2, amount: 3 }), "Approving $3.00 raises the budget from $2.00.");
  assert.equal(approvalHint({ category: null, budgetUsd: 2, amount: 2 }), totalStops);
  assert.equal(approvalHint({ category: null, budgetUsd: 2, amount: null }), totalStops);
  assert.equal(approvalHint({ category: "copy", budgetUsd: 2, amount: null }), "Enter the amount the copy budget should be raised to.");
  assert.equal(
    approvalHint({ category: "copy", budgetUsd: 2, amount: 0.75 }),
    "Approving $0.75 raises the copy budget. The amount must be above the copy budget the plan has now.",
  );
});

test("approvals are listed newest first, a time that cannot be read last, and the list passed is not changed", () => {
  const rows = [
    { id: "a", createdAt: "2026-10-23T09:00:00.000Z" },
    { id: "b", createdAt: "2026-10-23T11:00:00.000Z" },
    { id: "c", createdAt: "not a time" },
    { id: "d", createdAt: "2026-10-23T11:00:00.000Z" },
  ];
  const original = rows.map((row) => row.id).join();
  assert.deepEqual(
    approvalsNewestFirst(rows).map((row) => row.id),
    ["d", "b", "a", "c"],
    "two at the same time keep the larger id first",
  );
  assert.equal(rows.map((row) => row.id).join(), original);
  assert.deepEqual(approvalsNewestFirst([]), []);
});

test("an approval says who approved it, the approved budget and the budget it came from", () => {
  assert.equal(
    approvalText({ actor: "Ana Lopez", previousUsd: 1, approvedUsd: 2.5 }),
    "Ana Lopez approved $2.50, from a budget of $1.00.",
  );
  const members = [{ userId: "user_1", name: "Ana Lopez", email: "ana@example.test" }];
  assert.equal(actorNameOf("user_1", members), "Ana Lopez");
  assert.equal(actorNameOf("user_1", [{ ...members[0], name: "  " }]), "ana@example.test", "the email stands in for a blank name");
  assert.equal(actorNameOf("user_9", members), "A member no longer in this workspace");
});

test("the measured average is a measurement, with its clips, and no clip measured is said plainly", () => {
  assert.equal(measuredAverageText({ measuredAverageUsdPerSecond: null, clips: 0 }), "no clip measured yet");
  assert.equal(measuredAverageText({ measuredAverageUsdPerSecond: 0.0123, clips: 3 }), "measured average: $0.0123 per second over 3 clips");
  assert.equal(measuredAverageText({ measuredAverageUsdPerSecond: 0.5, clips: 1 }), "measured average: $0.5000 per second over 1 clip");
  assert.equal(measuredAverageText({ measuredAverageUsdPerSecond: 0.5, clips: 0 }), "no clip measured yet", "a value with no clip is not shown");
  assert.doesNotMatch(measuredAverageText({ measuredAverageUsdPerSecond: 0.0123, clips: 3 }), /estimat|expect|predict|will cost|forecast/i);
});

test("the measure ceiling is a number from 0.01 to 5 dollars a second, and anything else is null", () => {
  assert.equal(parseCeiling("0.5"), 0.5);
  assert.equal(parseCeiling("0.01"), CEILING.min);
  assert.equal(parseCeiling("5"), CEILING.max);
  for (const bad of ["", "   ", "0", "0.009", "5.01", "abc", "-1", "Infinity"]) {
    assert.equal(parseCeiling(bad), null, `${JSON.stringify(bad)} should not be a ceiling`);
  }
  assert.equal(ceilingText(0.5), "$0.50 per second");
});

test("a family is kept in lowercase with no leading tilde, and a typed list drops the empty and repeated entries", () => {
  assert.equal(normalizeFamily("  ~Vendor/Alpha  "), "vendor/alpha");
  assert.deepEqual(familiesFromText(" vendor/alpha, ,~Vendor/Beta, vendor/alpha ,"), ["vendor/alpha", "vendor/beta"]);
  assert.deepEqual(familiesFromText(""), []);
});

test("a family is added once and removed cleanly, and removing one that is not there changes nothing", () => {
  assert.deepEqual(withFamily(["vendor/alpha"], "vendor/beta", true), ["vendor/alpha", "vendor/beta"]);
  assert.deepEqual(withFamily(["vendor/alpha", "vendor/beta"], "vendor/alpha", true), ["vendor/alpha", "vendor/beta"]);
  assert.deepEqual(withFamily(["vendor/alpha", "vendor/beta"], "vendor/alpha", false), ["vendor/beta"]);
  assert.deepEqual(withFamily(["vendor/alpha"], "vendor/gamma", false), ["vendor/alpha"]);
});

test("the workspace list shows the families off by default even when they are switched on, then the others it switches off", () => {
  assert.deepEqual(workspaceFamilyRows({ defaults: ["vendor/one"], switchedOff: [] }), [
    { family: "vendor/one", switchedOff: false, locked: false, offByDefault: true },
  ]);
  assert.deepEqual(workspaceFamilyRows({ defaults: ["vendor/one"], switchedOff: ["vendor/one", "vendor/two"] }), [
    { family: "vendor/one", switchedOff: true, locked: false, offByDefault: true },
    { family: "vendor/two", switchedOff: true, locked: false, offByDefault: false },
  ]);
});

test("a family the workspace switches off is locked on for every brand, and no brand can switch it on", () => {
  const rows = brandFamilyRows({ workspaceFamilies: ["vendor/one"], brandFamilies: ["vendor/two", "vendor/one"] });
  assert.deepEqual(rows, [
    { family: "vendor/one", switchedOff: true, locked: true, offByDefault: false },
    { family: "vendor/two", switchedOff: true, locked: false, offByDefault: false },
  ]);
  // Switching the locked family on or off changes nothing: the brand's list comes back as it was.
  assert.deepEqual(brandFamiliesAfter(["vendor/two"], ["vendor/one"], "vendor/one", false), ["vendor/two"]);
  assert.deepEqual(brandFamiliesAfter(["vendor/two"], ["vendor/one"], "vendor/one", true), ["vendor/two"]);
  // A brand's own families switch off and on.
  assert.deepEqual(brandFamiliesAfter(["vendor/two"], ["vendor/one"], "vendor/three", true), ["vendor/two", "vendor/three"]);
  assert.deepEqual(brandFamiliesAfter(["vendor/two", "vendor/three"], ["vendor/one"], "vendor/two", false), ["vendor/three"]);
});

// The budget copy names no tolerance, allowance, percentage or cents: a budget is a line (D12).
const COPY_FILES = ["orchestrator-presentation.ts", "orchestrator-plans.tsx", "orchestrator-policy-panel.tsx"];
const TOLERANCE_WORDS = /tolerance|allowance|percent|cents/i;

test("the budget screens name no tolerance, allowance, percent or cents", () => {
  const hits: string[] = [];
  for (const name of COPY_FILES) {
    readFileSync(new URL(name, import.meta.url), "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (TOLERANCE_WORDS.test(line)) hits.push(`${name}:${index + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(hits, []);
});
