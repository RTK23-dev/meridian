/**
 * Pure model for the brand overview: pipeline stages, the next best action and the missing-items checklist.
 *
 * It reads only stored counts (the machine snapshot) and the stored review list. It has no React and no server imports,
 * so the rules can be tested directly. A stage is "done" only when a stored record proves it.
 *
 * Two stages have no record of their own in the snapshot. Decision is done once a creative or generation run exists, and
 * Brief is done once a creative record exists. The UI labels both as status only, with no count.
 */

/** Minimum filled brain fields before the pipeline is treated as started. Matches the gate the overview always used. */
export const MIN_BRAIN_FIELDS_FOR_PIPELINE = 4;

export type StageKey =
  | "market"
  | "research"
  | "opportunity"
  | "decision"
  | "brief"
  | "studio"
  | "review"
  | "publish"
  | "performance"
  | "learning";

/** done: proven by stored records. in_progress: work is waiting or started. blocked: an earlier stage is not done. */
export type StageState = "done" | "in_progress" | "blocked" | "not_started";

export type StageTo =
  | "/brands/$brandId/market"
  | "/brands/$brandId/opportunities"
  | "/brands/$brandId/studio"
  | "/brands/$brandId/reviews"
  | "/brands/$brandId/learning";

export type PipelineCounts = {
  competitors: number;
  documents: number;
  observations: number;
  creatives: number;
  openOpportunities: number;
  reviews: number;
  patterns: number;
  performanceRows: number;
};

export type PipelineInput = {
  counts: PipelineCounts;
  operating: { generationRuns: number; publishedTests: number };
  /** Approved plus rejected reviews from the stored review list. Null when that list is not loaded. */
  decidedReviews: number | null;
};

export type PipelineStage = {
  key: StageKey;
  label: string;
  to: StageTo;
  /** A stored count, or null when the snapshot has no count for this stage. */
  count: number | null;
  /** What the count counts, in words, such as "open" or "ads". Empty when there is no count. */
  unit: string;
  state: StageState;
};

type Definition = {
  key: StageKey;
  label: string;
  to: StageTo;
  count: number | null;
  unit: string;
  done: boolean;
  after: StageKey | null;
  /** True when stored work is waiting in this stage, even if some of it is finished. */
  waiting: boolean;
  /** True when a stored signal shows the stage has started but is not finished. */
  started: boolean;
};

const MARKET: StageTo = "/brands/$brandId/market";
const OPPORTUNITIES: StageTo = "/brands/$brandId/opportunities";
const STUDIO: StageTo = "/brands/$brandId/studio";
const REVIEWS: StageTo = "/brands/$brandId/reviews";
const LEARNING: StageTo = "/brands/$brandId/learning";

export function pipelineStages(input: PipelineInput): PipelineStage[] {
  const { counts, operating } = input;
  const research = counts.observations + counts.documents;
  const decided = input.decidedReviews ?? 0;
  const definitions: Definition[] = [
    { key: "market", label: "Market", to: MARKET, count: counts.competitors, unit: "competitors", done: counts.competitors > 0, after: null, waiting: false, started: counts.observations > 0 },
    { key: "research", label: "Research", to: MARKET, count: research, unit: "items", done: research > 0, after: null, waiting: false, started: false },
    { key: "opportunity", label: "Opportunity", to: OPPORTUNITIES, count: counts.openOpportunities, unit: "open", done: counts.openOpportunities > 0, after: "research", waiting: false, started: false },
    { key: "decision", label: "Decision", to: OPPORTUNITIES, count: null, unit: "", done: counts.creatives > 0 || operating.generationRuns > 0, after: "opportunity", waiting: false, started: counts.openOpportunities > 0 },
    { key: "brief", label: "Brief", to: STUDIO, count: null, unit: "", done: counts.creatives > 0, after: "decision", waiting: false, started: false },
    { key: "studio", label: "Studio", to: STUDIO, count: operating.generationRuns, unit: "runs", done: operating.generationRuns > 0, after: "brief", waiting: false, started: false },
    { key: "review", label: "Review", to: REVIEWS, count: counts.reviews, unit: "open", done: decided > 0, after: "studio", waiting: counts.reviews > 0, started: false },
    { key: "publish", label: "Publish", to: STUDIO, count: operating.publishedTests, unit: "ads", done: operating.publishedTests > 0, after: "review", waiting: false, started: false },
    { key: "performance", label: "Performance", to: LEARNING, count: counts.performanceRows, unit: "rows", done: counts.performanceRows > 0, after: "publish", waiting: false, started: false },
    { key: "learning", label: "Learning", to: LEARNING, count: counts.patterns, unit: "patterns", done: counts.patterns > 0, after: "performance", waiting: false, started: false },
  ];

  const states = new Map<StageKey, StageState>();
  return definitions.map((definition) => {
    const predecessor = definition.after ? states.get(definition.after) : undefined;
    let state: StageState;
    if (definition.done && !definition.waiting) state = "done";
    else if (predecessor !== undefined && predecessor !== "done") state = "blocked";
    else if (definition.waiting || definition.started) state = "in_progress";
    else state = "not_started";
    states.set(definition.key, state);
    return { key: definition.key, label: definition.label, to: definition.to, count: definition.count, unit: definition.unit, state };
  });
}

export type NextAction = {
  title: string;
  body: string;
  cta: string;
  to: "/brands/$brandId/brain" | StageTo;
  /** True when the title and body are the stored recommendation rather than the generic stage copy. */
  usesRecommendation: boolean;
};

export type Recommendation = { label: string; reason: string };

/**
 * One next action with one CTA. A thin brain comes first, because every recommendation cites the brain. Then the first
 * stage with work waiting, then the first stage that has not started. The stored recommendation replaces the generic
 * Opportunity copy when one exists.
 */
export function nextBestAction(input: {
  brainFilled: number;
  brainTotal: number;
  stages: PipelineStage[];
  recommendation: Recommendation | null;
}): NextAction {
  if (input.brainFilled < MIN_BRAIN_FIELDS_FOR_PIPELINE) {
    return {
      title: "Complete the brand brain",
      body: `${input.brainFilled} of ${input.brainTotal} brain fields are filled. Recommendations cite these fields, so add the ones you can confirm.`,
      cta: "Open brand brain",
      to: "/brands/$brandId/brain",
      usesRecommendation: false,
    };
  }
  const next = input.stages.find((stage) => stage.state === "in_progress")
    ?? input.stages.find((stage) => stage.state === "not_started");
  if (!next) {
    return {
      title: "Review current learning",
      body: "Your stored pipeline is up to date. Review the latest learning and decide what to explore next.",
      cta: "Open learning",
      to: LEARNING,
      usesRecommendation: false,
    };
  }
  if (next.key === "opportunity" && input.recommendation) {
    return {
      title: input.recommendation.label,
      body: input.recommendation.reason,
      cta: `Continue to ${next.label}`,
      to: next.to,
      usesRecommendation: true,
    };
  }
  return {
    title: next.label,
    body: `Continue with ${next.label.toLowerCase()} using the evidence already stored for this brand.`,
    cta: `Continue to ${next.label}`,
    to: next.to,
    usesRecommendation: false,
  };
}

export type MissingItem = { text: string; to: "/brands/$brandId/brain" | StageTo };

/** What is absent from the stored data, in the order a person would fix it. Empty when nothing is missing. */
export function missingItems(input: { brainFilled: number; counts: PipelineCounts; operating: { generationRuns: number } }): MissingItem[] {
  const items: MissingItem[] = [];
  if (input.brainFilled < MIN_BRAIN_FIELDS_FOR_PIPELINE) items.push({ text: "Complete the brand brain", to: "/brands/$brandId/brain" });
  if (input.counts.observations === 0) items.push({ text: "Collect competitor evidence", to: MARKET });
  if (input.counts.openOpportunities === 0) items.push({ text: "Rank opportunities from stored evidence", to: OPPORTUNITIES });
  if (input.operating.generationRuns === 0) items.push({ text: "Generate a first creative", to: STUDIO });
  if (input.counts.performanceRows === 0) items.push({ text: "Record a performance result", to: LEARNING });
  return items;
}

/** How many stages are done. The pipeline always has the same ten stages, so callers show "n of stages.length". */
export function doneCount(stages: PipelineStage[]): number {
  return stages.filter((stage) => stage.state === "done").length;
}

/** Approved and rejected reviews in a stored review list. An open review is waiting, not decided. */
export function countDecidedReviews(reviews: ReadonlyArray<{ status: string }>): number {
  return reviews.filter((review) => review.status === "approved" || review.status === "rejected").length;
}
