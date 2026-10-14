// Step 4 of the visual decision engine: fit the budget (Bible 7.6). Pure code.
//
// Start from the cheapest candidate of every shot. Then, while some upgrade fits the budget, apply the upgrade with the
// highest U-gain per cost-gain. Upgrades only go to strictly more expensive candidates, so the total cost rises on every
// step and the loop ends. If the cheapest plan already exceeds the budget, nothing can fit and the result says so.

import { MICRO_PER_USD, planTotals, usdAtMost, usdUnits, type PlanLine, type PlanTotals } from "./cost.ts";

export type FitCandidate = {
  baseUsd: number;
  totalUsd: number;
  generated: boolean;
};

export type FitInput = {
  /** Per shot, the candidates that survived the filter, in pool order. An empty list is an unfilled shot. */
  shots: readonly (readonly FitCandidate[])[];
  /** The whole request budget (fixed lines included). */
  requestBudgetUsd: number;
  /** U of candidate k on shot i, given the choices made so far (choice[i] itself is not read). */
  scoreAt: (shotIndex: number, candidateIndex: number, choice: readonly (number | null)[]) => number;
};

export type FitResult = {
  /** The chosen candidate index per shot, or null for an unfilled shot. */
  choice: (number | null)[];
  totals: PlanTotals;
  fitsBudget: boolean;
  upgrades: number;
};

function linesOf(shots: readonly (readonly FitCandidate[])[], choice: readonly (number | null)[]): PlanLine[] {
  const lines: PlanLine[] = [];
  choice.forEach((index, shotIndex) => {
    if (index !== null) {
      const candidate = shots[shotIndex][index];
      lines.push({ baseUsd: candidate.baseUsd, generated: candidate.generated });
    }
  });
  return lines;
}

export function fitBudget(input: FitInput): FitResult {
  const { shots, requestBudgetUsd, scoreAt } = input;
  const choice: (number | null)[] = shots.map(() => null);

  // Baseline: the cheapest candidate per shot. A tie on cost goes to the higher U, then to the earlier candidate.
  shots.forEach((options, shotIndex) => {
    if (options.length === 0) {
      return;
    }
    let best = 0;
    for (let candidate = 1; candidate < options.length; candidate++) {
      const costOf = usdUnits(options[candidate].totalUsd);
      const bestCost = usdUnits(options[best].totalUsd);
      if (costOf < bestCost) {
        best = candidate;
      } else if (costOf === bestCost && scoreAt(shotIndex, candidate, choice) > scoreAt(shotIndex, best, choice)) {
        best = candidate;
      }
    }
    choice[shotIndex] = best;
  });

  let totals = planTotals(linesOf(shots, choice));
  if (!usdAtMost(totals.reservedUsd, requestBudgetUsd)) {
    return { choice, totals, fitsBudget: false, upgrades: 0 };
  }

  // Upgrades: a strictly more expensive candidate with a positive U-gain that still fits. Pick the best ratio.
  let upgrades = 0;
  const maxSteps = shots.reduce((sum, options) => sum + options.length, 0) + 1;
  for (let step = 0; step < maxSteps; step++) {
    let best: { shot: number; candidate: number; ratio: number } | null = null;

    for (let shotIndex = 0; shotIndex < shots.length; shotIndex++) {
      const current = choice[shotIndex];
      if (current === null) {
        continue;
      }
      const options = shots[shotIndex];
      const currentCost = usdUnits(options[current].totalUsd);
      const currentScore = scoreAt(shotIndex, current, choice);

      for (let candidate = 0; candidate < options.length; candidate++) {
        const gainCostUnits = usdUnits(options[candidate].totalUsd) - currentCost;
        if (gainCostUnits <= 0) {
          continue;
        }
        const gainU = scoreAt(shotIndex, candidate, choice) - currentScore;
        if (!(gainU > 0)) {
          continue;
        }
        const trial = choice.slice();
        trial[shotIndex] = candidate;
        if (!usdAtMost(planTotals(linesOf(shots, trial)).reservedUsd, requestBudgetUsd)) {
          continue;
        }
        const ratio = gainU / (gainCostUnits / MICRO_PER_USD);
        if (best === null || ratio > best.ratio) {
          best = { shot: shotIndex, candidate, ratio };
        }
      }
    }

    if (best === null) {
      break;
    }
    choice[best.shot] = best.candidate;
    upgrades++;
  }

  totals = planTotals(linesOf(shots, choice));
  return { choice, totals, fitsBudget: usdAtMost(totals.reservedUsd, requestBudgetUsd), upgrades };
}
