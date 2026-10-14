// Step 3 of the visual decision engine: score each surviving candidate (Bible 7.5). Pure code. Every weight and the
// win-rate prior come from config (weights.ts); the tables come from tables.ts.
//
//   U(s, t) = wBeat * beatFit + wRef * referenceMatch + wStyle * styleFit + wWin * winRate
//           - wCost * costShare - wRisk * artifactRisk + wCont * continuity - wRep * repetition

import { weights } from "../config/weights.ts";
import { EngineError, type BeatRole, type VisualType } from "../contracts/index.ts";
import { BEAT_FIT, FAMILY_OF, ARTIFACT_RISK_PRIOR, STYLE_FIT, RECIPES, type Recipe } from "./tables.ts";
import type { CandidateOrigin } from "./types.ts";

/** Learned values for one page (16.2). A missing or thin value falls back to its prior and is labelled as one. */
export type LearnedStats = {
  winRate?: Partial<Record<VisualType, { wins: number; samples: number }>>;
  artifactRisk?: Partial<Record<VisualType, { failures: number; takes: number }>>;
};

export type PriorField = "winRate" | "artifactRisk";

export type ScoreContext = {
  beatRole: BeatRole;
  /** The type chosen for the previous shot, or null. */
  prevType: VisualType | null;
  /** The types chosen for earlier shots, oldest first. */
  recent: readonly VisualType[];
  /** Budget left for shots (cost.ts shotRoomUsd). Cost share is measured against it. */
  remainingUsd: number;
  styleKit: { preferredTypes: readonly VisualType[]; bannedTypes: readonly VisualType[] };
  learned: LearnedStats | undefined;
};

export type ScoreCandidate = {
  visualType: VisualType;
  proposalIndex: number | null;
  origin: CandidateOrigin;
  totalUsd: number;
};

export type ScoreTerms = {
  beatFit: number;
  referenceMatch: number;
  styleFit: number;
  winRate: number;
  costShare: number;
  artifactRisk: number;
  continuity: number;
  repetition: number;
};

export type Scored = {
  visualType: VisualType;
  score: number;
  terms: ScoreTerms;
  /** The fields that used their prior rather than a learned value. */
  priors: PriorField[];
};

function checkCount(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new EngineError("invalid_input", `${name} must be a whole number of 0 or more, got ${String(value)}`);
  }
}

/** The win rate of a type on this page: learned once it has enough samples, else the prior (7.5). */
export function winRateOf(visualType: VisualType, learned: LearnedStats | undefined): { value: number; prior: boolean } {
  const stat = learned?.winRate?.[visualType];
  if (stat === undefined) {
    return { value: weights.winRatePrior.value, prior: true };
  }
  checkCount(stat.samples, `winRate samples for ${visualType}`);
  checkCount(stat.wins, `winRate wins for ${visualType}`);
  if (stat.wins > stat.samples) {
    throw new EngineError("invalid_input", `winRate wins for ${visualType} cannot exceed its samples`);
  }
  if (stat.samples < weights.winRateMinSamples) {
    return { value: weights.winRatePrior.value, prior: true };
  }
  return { value: stat.wins / stat.samples, prior: false };
}

/**
 * The take failure rate of a type (7.5). The Bible gives the prior by catalogue class only, so the learned rate uses the
 * same minimum sample count as the win rate. That reuse is noted in plan/STATUS.md.
 */
export function artifactRiskOf(
  visualType: VisualType,
  learned: LearnedStats | undefined,
): { value: number; prior: boolean } {
  const recipe: Recipe = RECIPES[visualType];
  const prior = ARTIFACT_RISK_PRIOR[recipe.kind];
  const stat = learned?.artifactRisk?.[visualType];
  if (stat === undefined) {
    return { value: prior, prior: true };
  }
  checkCount(stat.takes, `artifactRisk takes for ${visualType}`);
  checkCount(stat.failures, `artifactRisk failures for ${visualType}`);
  if (stat.failures > stat.takes) {
    throw new EngineError("invalid_input", `artifactRisk failures for ${visualType} cannot exceed its takes`);
  }
  if (stat.takes < weights.winRateMinSamples) {
    return { value: prior, prior: true };
  }
  return { value: stat.failures / stat.takes, prior: false };
}

/** Reference match by the candidate's place in the 7.4 list: first 1, second 0.6, others 0.3 (config). */
export function referenceMatchOf(proposalIndex: number | null): number {
  const order = weights.referenceMatchByOrder;
  if (proposalIndex === 0) {
    return order.first;
  }
  if (proposalIndex === 1) {
    return order.second;
  }
  return order.other;
}

export function styleFitOf(
  visualType: VisualType,
  styleKit: { preferredTypes: readonly VisualType[]; bannedTypes: readonly VisualType[] },
): number {
  if (styleKit.bannedTypes.includes(visualType)) {
    return STYLE_FIT.banned;
  }
  if (styleKit.preferredTypes.includes(visualType)) {
    return STYLE_FIT.preferred;
  }
  return STYLE_FIT.neutral;
}

/** How many of the most recent shots in a row are this type. */
export function runLengthOf(visualType: VisualType, recent: readonly VisualType[]): number {
  let run = 0;
  for (let index = recent.length - 1; index >= 0 && recent[index] === visualType; index--) {
    run++;
  }
  return run;
}

/** Score one candidate on one shot. Pure: the same inputs give the same score. */
export function scoreCandidate(candidate: ScoreCandidate, context: ScoreContext): Scored {
  const visualType = candidate.visualType;
  const v = weights.visualScore;

  const beatFit = BEAT_FIT[context.beatRole][visualType];
  const referenceMatch = referenceMatchOf(candidate.proposalIndex);
  const styleFit = styleFitOf(visualType, context.styleKit);
  const win = winRateOf(visualType, context.learned);
  const costShare =
    context.remainingUsd > 0 ? Math.min(1, candidate.totalUsd / context.remainingUsd) : 0;
  const risk = artifactRiskOf(visualType, context.learned);
  const continuity =
    context.prevType !== null && FAMILY_OF[context.prevType] === FAMILY_OF[visualType] ? 1 : 0;
  // A repetition penalty when this type would make a run of repetitionRunLength shots (7.5, config).
  const repetition =
    runLengthOf(visualType, context.recent) + 1 >= weights.repetitionRunLength ? 1 : 0;

  const terms: ScoreTerms = {
    beatFit,
    referenceMatch,
    styleFit,
    winRate: win.value,
    costShare,
    artifactRisk: risk.value,
    continuity,
    repetition,
  };

  const score =
    v.beatFit.value * beatFit +
    v.referenceMatch.value * referenceMatch +
    v.styleFit.value * styleFit +
    v.winRate.value * win.value -
    v.costShare.value * costShare -
    v.artifactRisk.value * risk.value +
    v.continuity.value * continuity -
    v.repetition.value * repetition;

  const priors: PriorField[] = [];
  if (win.prior) {
    priors.push("winRate");
  }
  if (risk.prior) {
    priors.push("artifactRisk");
  }

  return { visualType, score, terms, priors };
}
