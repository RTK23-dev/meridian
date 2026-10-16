// The visual decision engine (Bible section 7): steps 1 to 4 as one pure function. Step 5, the Opus director check, is a
// Claude call and lives in director.ts (E3), which applies its answer to the choices this file returns. Every choice returns
// a Decision with its alternatives, scores and reason (by: scorer).
//
//   1. filter     the six hard rules (7.2), with the `must` mapping (7.3) applied as rule 1
//   2. propose    the candidate pool from the example's shot type, the `may` and `must` types, and downgrade chains (7.4)
//   3. score      U(s, t) with every weight from config (7.5)
//   4. fit        cheapest per shot, then the best U-gain per cost-gain while it fits the budget (7.6)

import { budgets } from "../config/budgets.ts";
import { prices } from "../config/prices.ts";
import { weights } from "../config/weights.ts";
import { EngineError, usdSchema, type Decision, type VisualType } from "../contracts/index.ts";
import { MICRO_PER_USD, shotRoomUsd, type PlanTotals } from "./cost.ts";
import { filterCandidates, mustAllowedTypes, mustShowsProduct, type FilteredCandidate } from "./filter.ts";
import { fitBudget } from "./fit.ts";
import { proposeCandidates } from "./propose.ts";
import { scoreCandidate, type LearnedStats, type PriorField, type Scored } from "./score.ts";
import { DOWNGRADE_TO, PLAN_TABLES_VERSION, isGeneratedType } from "./tables.ts";
import type { PlanKits, Rejection, ShotInput } from "./types.ts";

export type VisualDecisionInput = {
  /** The shots of the master in timeline order, each after the reference alignment (6.4 step 1). */
  shots: readonly ShotInput[];
  styleKit: { preferredTypes: readonly VisualType[]; bannedTypes: readonly VisualType[] };
  kits: PlanKits;
  /** Learned values for this page (16.2). Omit them to use the priors, which the decisions then label. */
  learned?: LearnedStats;
  /** ProductionRequest.constraints.budgetUsd: the whole request budget, fixed lines included. */
  requestBudgetUsd: number;
};

/** A candidate that survived the filter for one shot, with what choosing it would cost and score (step 3 in the context of the choice). */
export type ShotCandidate = {
  visualType: VisualType;
  generated: boolean;
  /** The shot cost before the redo allowance (cost.ts). */
  baseUsd: number;
  /** baseUsd plus the redo allowance: what the candidate costs against the budget (7.2 rule 5). */
  totalUsd: number;
  /** U(s, t) with the choices of the other shots as the fit left them. */
  score: number;
};

export type ShotChoice = {
  shotId: string;
  /** The chosen type, or null when no candidate survives (an unfilled shot; the plan gate refuses it). */
  visualType: VisualType | null;
  generated: boolean;
  /** The first target of the 7.1 downgrade chain, set for every generated choice (6.4 step 5). */
  downgradeTo: VisualType | null;
  /** The shot cost before the redo allowance, or null when unfilled. */
  baseUsd: number | null;
  score: number | null;
  /** The `must` requests this shot satisfies, joined with "; ", or null when it has none. */
  mustSatisfy: string | null;
  rejected: Rejection[];
  /** Every candidate that survived the filter, in pool order. The director's swaps must stay inside this list (7.7). */
  candidates: ShotCandidate[];
};

export type VisualDecisionResult = {
  versions: { planTables: string; weights: string; budgets: string; prices: string };
  shots: ShotChoice[];
  decisions: Decision[];
  totals: PlanTotals & { requestBudgetUsd: number; remainingUsd: number; fitsBudget: boolean };
  /** Shots with no candidate left after the filter. */
  unfilled: string[];
  /** Unfilled shots whose beat has a must request: that must cannot be honoured within the budget and filter. */
  unsatisfiedMust: string[];
};

function round4(value: number): number {
  return Math.round(value * MICRO_PER_USD) / MICRO_PER_USD;
}

function validateInput(input: VisualDecisionInput): void {
  if (input.shots.length === 0) {
    throw new EngineError("invalid_input", "the visual decision needs at least one shot");
  }
  if (!usdSchema.safeParse(input.requestBudgetUsd).success) {
    throw new EngineError("invalid_input", "requestBudgetUsd must be a USD amount, finite, >= 0, at most 4 decimals");
  }
  const ids = new Set<string>();
  let previousEnd = 0;
  input.shots.forEach((shot, index) => {
    if (shot.shotId.length === 0 || ids.has(shot.shotId)) {
      throw new EngineError("invalid_input", `shot ${index} needs a unique non-empty shotId`);
    }
    ids.add(shot.shotId);
    if (!Number.isInteger(shot.startMs) || !Number.isInteger(shot.endMs) || shot.startMs < 0) {
      throw new EngineError("invalid_input", `shot ${shot.shotId} needs integer millisecond times`);
    }
    if (shot.endMs <= shot.startMs) {
      throw new EngineError("invalid_input", `shot ${shot.shotId} must end after it starts`);
    }
    if (shot.startMs < previousEnd) {
      throw new EngineError("invalid_input", `shot ${shot.shotId} overlaps the shot before it; shots are in timeline order`);
    }
    previousEnd = shot.endMs;
  });
}

function labelFor(scored: Scored): string {
  return scored.priors.length === 0 ? scored.visualType : `${scored.visualType} (prior: ${scored.priors.join(", ")})`;
}

function priorsSentence(priors: readonly PriorField[]): string {
  if (priors.length === 0) {
    return "";
  }
  return ` ${priors.join(" and ")} ${priors.length === 1 ? "is" : "are"} a prior, not a learned value.`;
}

/** Decide the visual type of every shot. Pure: the same input gives the same result. */
export function decideVisuals(input: VisualDecisionInput): VisualDecisionResult {
  validateInput(input);
  const remainingUsd = shotRoomUsd(input.requestBudgetUsd);

  const prepared = input.shots.map((shot) => {
    const musts = shot.requests.filter((request) => request.strength === "must");
    return {
      shot,
      mustAllowed: mustAllowedTypes(shot.requests),
      mustWants: musts.map((request) => request.want),
      showsProduct: shot.flags.showsProduct || mustShowsProduct(shot.requests),
      durationMs: shot.endMs - shot.startMs,
    };
  });

  // Steps 2 and 1: propose a pool per shot, then filter it with the six rules.
  const filtered: { kept: FilteredCandidate[]; rejected: Rejection[] }[] = prepared.map((item) => {
    const pool = proposeCandidates({
      refShot: item.shot.refShot,
      requests: item.shot.requests,
      mustAllowed: item.mustAllowed,
    });
    return filterCandidates({
      candidates: pool,
      kits: input.kits,
      remainingUsd,
      durationMs: item.durationMs,
      mustAllowed: item.mustAllowed,
      showsProduct: item.showsProduct,
      textInPixels: item.shot.flags.textInPixels,
      handsOnProduct: item.shot.flags.handsOnProduct,
      refusals: item.shot.refusals,
    });
  });

  // Step 3: U of candidate k on shot i, with the context the earlier choices give.
  const scoreDetail = (shotIndex: number, candidateIndex: number, choice: readonly (number | null)[]): Scored => {
    const typeAt = (index: number): VisualType | null => {
      const chosen = choice[index];
      return chosen === null || chosen === undefined ? null : filtered[index].kept[chosen].visualType;
    };
    const recent: VisualType[] = [];
    for (let index = 0; index < shotIndex; index++) {
      const type = typeAt(index);
      if (type !== null) {
        recent.push(type);
      }
    }
    const candidate = filtered[shotIndex].kept[candidateIndex];
    return scoreCandidate(
      {
        visualType: candidate.visualType,
        proposalIndex: candidate.proposalIndex,
        origin: candidate.origin,
        totalUsd: candidate.cost.totalUsd,
      },
      {
        beatRole: prepared[shotIndex].shot.beatRole,
        prevType: shotIndex > 0 ? typeAt(shotIndex - 1) : null,
        recent,
        remainingUsd,
        styleKit: input.styleKit,
        learned: input.learned,
      },
    );
  };

  // Step 4: fit the budget.
  const fit = fitBudget({
    shots: filtered.map((item) =>
      item.kept.map((candidate) => ({
        baseUsd: candidate.cost.baseUsd,
        totalUsd: candidate.cost.totalUsd,
        generated: candidate.cost.generated,
      })),
    ),
    requestBudgetUsd: input.requestBudgetUsd,
    scoreAt: (shotIndex, candidateIndex, choice) => scoreDetail(shotIndex, candidateIndex, choice).score,
  });

  const shots: ShotChoice[] = [];
  const decisions: Decision[] = [];
  const unfilled: string[] = [];
  const unsatisfiedMust: string[] = [];

  prepared.forEach((item, shotIndex) => {
    const { shot } = item;
    const rejected = filtered[shotIndex].rejected;
    const chosenIndex = fit.choice[shotIndex];
    const rejectedText =
      rejected.length === 0
        ? ""
        : ` Removed: ${rejected.map((entry) => `${entry.visualType} (${entry.rule})`).join("; ")}.`;

    if (chosenIndex === null) {
      unfilled.push(shot.shotId);
      if (item.mustAllowed !== null) {
        unsatisfiedMust.push(shot.shotId);
      }
      shots.push({
        shotId: shot.shotId,
        visualType: null,
        generated: false,
        downgradeTo: null,
        baseUsd: null,
        score: null,
        mustSatisfy: null,
        rejected,
        candidates: [],
      });
      decisions.push({
        at: shot.shotId,
        chose: "none",
        alternatives: [],
        reason: `No candidate survives the filter for a ${shot.beatRole} beat (reference ${shot.refShot}).${rejectedText}`,
        by: "scorer",
      });
      return;
    }

    const kept = filtered[shotIndex].kept;
    const chosen = scoreDetail(shotIndex, chosenIndex, fit.choice);
    const alternatives = kept
      .map((_, candidateIndex) => ({ candidateIndex, scored: scoreDetail(shotIndex, candidateIndex, fit.choice) }))
      .filter((entry) => entry.candidateIndex !== chosenIndex)
      .sort((a, b) => b.scored.score - a.scored.score || a.candidateIndex - b.candidateIndex);

    const chosenCandidate = kept[chosenIndex];
    const generated = isGeneratedType(chosen.visualType);
    const downgradeTo = generated ? (DOWNGRADE_TO[chosen.visualType][0] ?? null) : null;
    const mustSatisfy = item.mustWants.length > 0 ? item.mustWants.join("; ") : null;

    const candidates: ShotCandidate[] = kept.map((candidate, candidateIndex) => ({
      visualType: candidate.visualType,
      generated: candidate.cost.generated,
      baseUsd: candidate.cost.baseUsd,
      totalUsd: candidate.cost.totalUsd,
      score: round4(scoreDetail(shotIndex, candidateIndex, fit.choice).score),
    }));
    shots.push({
      shotId: shot.shotId,
      visualType: chosen.visualType,
      generated,
      downgradeTo,
      baseUsd: chosenCandidate.cost.baseUsd,
      score: round4(chosen.score),
      mustSatisfy,
      rejected,
      candidates,
    });
    decisions.push({
      at: shot.shotId,
      chose: chosen.visualType,
      alternatives: alternatives.map((entry) => ({
        option: labelFor(entry.scored),
        score: round4(entry.scored.score),
      })),
      reason:
        `Chose ${chosen.visualType} for a ${shot.beatRole} beat (reference ${shot.refShot}), score ${round4(chosen.score)}.` +
        priorsSentence(chosen.priors) +
        (mustSatisfy === null ? "" : ` Honours the must request: ${mustSatisfy}.`) +
        rejectedText,
      by: "scorer",
    });
  });

  return {
    versions: {
      planTables: PLAN_TABLES_VERSION,
      weights: weights.version,
      budgets: budgets.version,
      prices: prices.version,
    },
    shots,
    decisions,
    totals: {
      ...fit.totals,
      requestBudgetUsd: input.requestBudgetUsd,
      remainingUsd,
      fitsBudget: fit.fitsBudget,
    },
    unfilled,
    unsatisfiedMust,
  };
}

