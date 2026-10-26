import assert from "node:assert/strict";
import { test } from "node:test";
import { openRouterProgress } from "./engine-progress.ts";

const base = { keySaved: false, testPassed: false, active: false, activeLabel: "TypeSafe JEV" };

test("a saved key is not a passed test and not an active engine", () => {
  const progress = openRouterProgress({ ...base, keySaved: true });
  assert.deepEqual(progress.steps.map((step) => step.done), [true, false, false]);
  assert.match(progress.next, /Test the connection/);
  assert.match(progress.next, /does not switch the engine/);
});

test("a passed test still names which engine is receiving decisions", () => {
  const progress = openRouterProgress({ ...base, keySaved: true, testPassed: true });
  assert.match(progress.next, /TypeSafe JEV receives every decision/);
});

test("only an active, tested, saved engine reads as finished", () => {
  const progress = openRouterProgress({ keySaved: true, testPassed: true, active: true, activeLabel: "OpenRouter Decisions" });
  assert.ok(progress.steps.every((step) => step.done));
  assert.match(progress.next, /Nothing more/);
});

test("no key says to save one first", () => {
  assert.match(openRouterProgress(base).next, /Save your OpenRouter key/);
});

import { budgetBlocker } from "./engine-progress.ts";
import { NO_MONTHLY_BUDGET_REASON } from "../../lib/meridian/providers/generation-ledger.ts";

test("the ledger's own refusal is read as a missing budget, with nothing sent", () => {
  assert.deepEqual(budgetBlocker(NO_MONTHLY_BUDGET_REASON), { blocked: true, nothingSent: true });
});

test("an unrelated failure is not a budget blocker, and claims nothing", () => {
  assert.deepEqual(budgetBlocker("The provider rejected the key."), { blocked: false, nothingSent: false });
});

test("a budget message that does not say nothing was sent does not claim it", () => {
  assert.deepEqual(budgetBlocker("Set a monthly budget."), { blocked: true, nothingSent: false });
});
