import assert from "node:assert/strict";
import test from "node:test";
import { FIXED_PER_MASTER_USD } from "./cost.ts";
import { fitBudget, type FitCandidate } from "./fit.ts";

/** A request budget that leaves `shotUsd` for shots after the fixed per-master lines (14.2). */
const budget = (shotUsd: number): number => FIXED_PER_MASTER_USD + shotUsd;

const option = (totalUsd: number, generated = totalUsd > 0): FitCandidate => ({ baseUsd: totalUsd / (generated ? 1.25 : 1), totalUsd, generated });

/** A U that depends only on the candidate: scoreAt returns the value of the candidate index for each shot. */
function scores(table: number[][]): (shot: number, candidate: number) => number {
  return (shot, candidate) => table[shot][candidate];
}

test("the baseline is the cheapest candidate per shot", () => {
  const shots = [[option(0), option(0.5)], [option(0.2), option(0)]];
  const result = fitBudget({ shots, requestBudgetUsd: budget(0.2), scoreAt: scores([[0.1, 0.9], [0.1, 0.1]]) });
  assert.deepEqual(result.choice, [0, 1]);
  assert.equal(result.upgrades, 0);
});

test("a tie on cost goes to the higher U, then the earlier candidate", () => {
  const shots = [[option(0.1, false), option(0.1, false)]];
  assert.deepEqual(fitBudget({ shots, requestBudgetUsd: budget(1), scoreAt: scores([[0.2, 0.7]]) }).choice, [1]);
  assert.deepEqual(fitBudget({ shots, requestBudgetUsd: budget(1), scoreAt: scores([[0.5, 0.5]]) }).choice, [0]);
});

test("the upgrade with the best U-gain per cost-gain is applied first, while it fits", () => {
  // Two shots, each cheapest at 0. Upgrade A: +0.6 U for 0.5 (ratio 1.2). Upgrade B: +0.3 U for 0.1 (ratio 3.0).
  const shots = [[option(0), option(0.5)], [option(0), option(0.1)]];
  const result = fitBudget({ shots, requestBudgetUsd: budget(0.1), scoreAt: scores([[0.1, 0.7], [0.1, 0.4]]) });
  assert.deepEqual(result.choice, [0, 1], "the cheaper, better-ratio upgrade is applied; the other does not fit");
  assert.equal(result.upgrades, 1);
  assert.ok(result.totals.reservedUsd <= budget(0.1) + 1e-9);
});

test("an upgrade that would push the plan over the budget is never applied", () => {
  const shots = [[option(0), option(1)]];
  const result = fitBudget({ shots, requestBudgetUsd: budget(0.5), scoreAt: scores([[0.1, 0.9]]) });
  assert.deepEqual(result.choice, [0]);
  assert.equal(result.fitsBudget, true);
});

test("when the cheapest plan is already over budget, nothing fits and no upgrade is tried", () => {
  const shots = [[option(0.6)], [option(0.6)]];
  const result = fitBudget({ shots, requestBudgetUsd: budget(0.5), scoreAt: scores([[0.5], [0.5]]) });
  assert.equal(result.fitsBudget, false);
  assert.equal(result.upgrades, 0);
});

test("an unfilled shot (no candidate) stays null and adds nothing to the total", () => {
  const shots = [[], [option(0.2, false)]];
  const result = fitBudget({ shots, requestBudgetUsd: budget(1), scoreAt: scores([[], [0.5]]) });
  assert.deepEqual(result.choice, [null, 0]);
  assert.equal(result.totals.shotsUsd, 0.2);
});

test("the loop ends: upgrades strictly raise the cost, so a fit with many candidates terminates", () => {
  const shots = [0, 1, 2].map(() => [option(0), option(0.1), option(0.2), option(0.3)]);
  const table = [0, 1, 2].map(() => [0.1, 0.4, 0.2, 0.9]);
  const result = fitBudget({ shots, requestBudgetUsd: budget(10), scoreAt: scores(table) });
  assert.ok(result.upgrades <= 9);
  assert.equal(result.fitsBudget, true);
});

test("the planner's fit is deterministic", () => {
  const shots = [[option(0), option(0.2)], [option(0), option(0.2)]];
  const table = [[0.1, 0.6], [0.1, 0.6]];
  assert.deepEqual(
    fitBudget({ shots, requestBudgetUsd: budget(0.2), scoreAt: scores(table) }),
    fitBudget({ shots, requestBudgetUsd: budget(0.2), scoreAt: scores(table) }),
  );
});
