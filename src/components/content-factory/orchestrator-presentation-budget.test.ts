import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { UNREADABLE_POLICY_REASON } from "../../engine/orchestrator/policy-store.ts";
import {
  BUDGET_PAUSE_HEADING,
  CEILING,
  MONTH_PAUSE_SENTENCE,
  UNREADABLE_POLICY_SENTENCE,
  actorNameOf,
  approvalCategoryOf,
  approvalHint,
  approvalText,
  approvalsNewestFirst,
  brandFamiliesAfter,
  brandFamilyRows,
  budgetPauseDetail,
  budgetPauseHeading,
  ceilingText,
  familiesFromText,
  isUnreadablePolicyError,
  measuredAverageText,
  normalizeFamily,
  parseCeiling,
  pauseCategoryOf,
  pauseLineOf,
  withFamily,
  workspaceFamilyRows,
} from "./orchestrator-presentation.ts";

const TOTAL_REASON =
  "budget reached, project not finished: the next step's hold of $0.4000 would take the spend past the $2.0000 budget (committed $1.8000)";
const COPY_REASON =
  "copy budget reached, project not finished: the next step's hold of $0.2000 would take the spend past the $0.5000 copy budget (committed $0.4000)";
// The wording a call refused by the workspace month carries (budget/reserve.ts), after the run's own opening (execute.ts).
const MONTH_REASON =
  "budget reached, project not finished: the workspace month has committed 40 USD, at or above its 40 USD budget, so no paid call starts";
const MONTH_PROJECTED_REASON =
  "budget reached, project not finished: call video would take the workspace month to 41 USD, above its 40 USD budget, so it does not start";

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

test("a pause names the line it stopped at, read from the pause event's reason: the total, the workspace month, or a category", () => {
  assert.equal(pauseCategoryOf(TOTAL_REASON), null);
  assert.equal(pauseCategoryOf(COPY_REASON), "copy");
  assert.equal(pauseCategoryOf("creative budget reached, project not finished: the next step's hold"), "creative");
  assert.equal(pauseCategoryOf("Voice budget reached, project not finished"), "voice", "the match ignores case");
  assert.equal(pauseCategoryOf("the run stopped for another reason"), null);
  assert.equal(pauseCategoryOf(null), null);

  assert.equal(pauseLineOf(TOTAL_REASON), "total");
  assert.equal(pauseLineOf(COPY_REASON), "copy");
  assert.equal(pauseLineOf(null), "total", "a pause with no reason is not read as a month or a category");
  assert.equal(pauseLineOf(MONTH_REASON), "month");
  assert.equal(pauseLineOf(MONTH_PROJECTED_REASON), "month");
  assert.equal(pauseLineOf("workspace monthly budget reached: the run is not started"), "month", "the monthly wording is the month too");

  assert.equal(budgetPauseHeading("total"), "Budget reached, project not finished");
  assert.equal(budgetPauseHeading("month"), "Budget reached, project not finished", "the month pause keeps the budget heading");
  assert.equal(budgetPauseHeading("copy"), "Copy budget reached, project not finished");
  assert.equal(budgetPauseHeading("voice"), "Voice budget reached, project not finished");
});

test("a month pause says the month is at its budget and to raise the monthly budget in settings, and its reason keeps the run's words", () => {
  assert.equal(MONTH_PAUSE_SENTENCE, "The workspace month is at its budget; raise the monthly budget in settings.");
  assert.equal(
    budgetPauseDetail(MONTH_REASON),
    "The workspace month has committed 40 USD, at or above its 40 USD budget, so no paid call starts",
  );
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

test("an approval says who approved it and the amounts; a category's approval names its category and its own line", () => {
  assert.equal(
    approvalText({ actor: "Ana Lopez", previousUsd: 1, approvedUsd: 2.5 }),
    "Ana Lopez approved $2.50, from a budget of $1.00.",
    "a total approval names no category",
  );
  assert.equal(
    approvalText({ actor: "Ana Lopez", previousUsd: 0.5, approvedUsd: 0.75, category: "copy" }),
    "Ana Lopez approved the copy budget at $0.75, from $0.50.",
  );
  // The audit row names the category in its reason, because the audit table has no category column (approval.ts).
  assert.equal(approvalCategoryOf(`category copy; ${COPY_REASON}`), "copy");
  assert.equal(approvalCategoryOf(`category voice; voice budget reached, project not finished: x`), "voice");
  assert.equal(approvalCategoryOf(TOTAL_REASON), null);
  assert.equal(approvalCategoryOf("category other; x"), null);
  assert.equal(approvalCategoryOf(null), null);
  const members = [{ userId: "user_1", name: "Ana Lopez", email: "ana@example.test" }];
  assert.equal(actorNameOf("user_1", members), "Ana Lopez");
  assert.equal(actorNameOf("user_1", [{ ...members[0], name: "  " }]), "ana@example.test", "the email stands in for a blank name");
  assert.equal(actorNameOf("user_9", members), "A member no longer in this workspace");
});

test("an unreadable policy row is recognised by the engine's reason, and is said as a sentence", () => {
  assert.equal(UNREADABLE_POLICY_SENTENCE, "The workspace's orchestrator policy is unreadable; save the policy again.");
  assert.equal(isUnreadablePolicyError(new Error(UNREADABLE_POLICY_REASON)), true);
  assert.equal(isUnreadablePolicyError(UNREADABLE_POLICY_REASON), true, "a plain string carries the reason too");
  assert.equal(isUnreadablePolicyError(new Error("Brand not found.")), false);
  assert.equal(isUnreadablePolicyError(null), false);
  assert.equal(isUnreadablePolicyError(undefined), false);
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
