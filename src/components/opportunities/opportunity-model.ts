/**
 * Pure rules for the opportunities screen. It imports only the copy module, which imports nothing, so the same rules can run
 * under `node --experimental-strip-types`. A missing value stays `null`: it is never shown as zero and never sorts as zero.
 */

import { decisionOutcome, percentOrUnknown } from "../../lib/copy.ts";

export type OpportunityCategory = "discovered" | "supported" | "hypothesis";
export type OpportunitySortKey = "rank" | "confidence" | "status" | "risk" | "probability";
export type SortDirection = "asc" | "desc";
export type ScoreKey = "brandFit" | "historicalEvidence" | "marketSignal" | "novelty" | "reproducibility" | "saturation" | "risk";

/** The fields of an opportunity row that these rules read. The screen passes its server rows, which carry more. */
export type OpportunityRow = {
  id: string;
  label: string;
  category: string;
  status: string;
  decision: string;
  /** The server returns null when no JEV decision stored a probability. Read it through `jevProbability`, never directly. */
  probability: number | null;
  confidence: number;
  expectedValue: number;
  risk: number;
  saturation: number;
  brandFit: number;
  historicalEvidence: number;
  marketSignal: number;
  novelty: number;
  reproducibility: number;
  reason: string;
  evidence: { id: string; source: string; summary: string }[];
  evidenceBasis: string;
  supportingCreativeIds: string[];
  researchSampleCount?: number;
  researchState?: string;
  researchConfidence?: number;
  researchSourceIds?: string[];
  researchAnalysisIds?: string[];
};

export const CATEGORY_LEGEND: ReadonlyArray<{ key: OpportunityCategory; label: string; description: string }> = [
  { key: "discovered", label: "Discovered", description: "Found in stored competitor rows. It did not come from the list of starting ideas." },
  { key: "supported", label: "Supported", description: "A starting idea that stored competitor observations or learned performance patterns back." },
  { key: "hypothesis", label: "Idea to test", description: "A starting idea with no stored observation or performance pattern behind it. Test it. Do not treat it as a finding." },
];

export function categoryLabel(category: string): string {
  return CATEGORY_LEGEND.find((item) => item.key === category)?.label ?? "Unclassified";
}

/** A finite number, or null. Anything else, including NaN and missing values, is unknown. */
export function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** JEV probability is known only when a JEV decision is stored. Without one the server returns null, which reads as Unknown. */
export function jevProbability(item: Pick<OpportunityRow, "decision" | "probability">): number | null {
  return item.decision ? finiteOrNull(item.probability) : null;
}

/** The decision in words. The stored code stays on the row and is shown under Details by the screen. */
export function jevDecisionLabel(decision: string): string {
  return decisionOutcome(decision);
}

/** The server reports a hold as a human-review decision on an open opportunity. */
export function isHeld(item: Pick<OpportunityRow, "decision" | "status">): boolean {
  return item.decision === "HUMAN_REVIEW" && item.status === "open";
}

/** Matches the server: a rejected or dismissed opportunity cannot be dismissed again or sent to Studio. */
export function canDismiss(status: string): boolean {
  return status !== "rejected" && status !== "dismissed";
}

/** Matches `dismissOpportunity` on the server, which accepts only open or rejected rows. */
export function isBulkSelectable(status: string): boolean {
  return status === "open" || status === "rejected";
}

/** Scale a 0 to 1 value to a bar width. Unknown stays unknown. Values outside 0 to 1 are clamped for the bar only. */
export function barPercent(value: number | null): number | null {
  if (value === null) return null;
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}

/**
 * Compares two values where either may be unknown. Unknown values always sort last, in both directions, so an unknown
 * probability is never placed as if it were zero.
 */
export function compareKnown(left: number | null, right: number | null, direction: SortDirection): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return direction === "asc" ? left - right : right - left;
}

export function compareOpportunities(left: OpportunityRow, right: OpportunityRow, key: OpportunitySortKey, direction: SortDirection): number {
  switch (key) {
    case "rank":
      return compareKnown(finiteOrNull(left.expectedValue), finiteOrNull(right.expectedValue), direction);
    case "confidence":
      return compareKnown(finiteOrNull(left.confidence), finiteOrNull(right.confidence), direction);
    case "risk":
      return compareKnown(finiteOrNull(left.risk), finiteOrNull(right.risk), direction);
    case "probability":
      return compareKnown(jevProbability(left), jevProbability(right), direction);
    case "status": {
      const order = left.status.localeCompare(right.status);
      return direction === "asc" ? order : -order;
    }
  }
}

/** Sorts by the chosen key. Ties fall back to rank score (highest first) and then to the label, so the order is stable. */
export function sortOpportunities(rows: readonly OpportunityRow[], key: OpportunitySortKey, direction: SortDirection): OpportunityRow[] {
  return [...rows].sort((left, right) =>
    compareOpportunities(left, right, key, direction)
    || compareOpportunities(left, right, "rank", "desc")
    || left.label.localeCompare(right.label));
}

/** One-based position by rank score, highest first. This is the position the server's default order gives. */
export function rankPositions(rows: readonly OpportunityRow[]): Map<string, number> {
  const ordered = [...rows].sort((left, right) => compareOpportunities(left, right, "rank", "desc"));
  return new Map(ordered.map((item, index) => [item.id, index + 1]));
}

export function filterOpportunities(rows: readonly OpportunityRow[], filter: { category: OpportunityCategory | "all"; status: string }): OpportunityRow[] {
  return rows.filter((item) =>
    (filter.category === "all" || item.category === filter.category)
    && (filter.status === "all" || item.status === filter.status));
}

export type ScoreDimension = {
  key: ScoreKey;
  label: string;
  /** Null when the value is unknown. Unknown parts are left out of the shape instead of drawn as zero. */
  value: number | null;
  /** Whether the part adds to the rank or is subtracted from it. */
  effect: "adds" | "subtracts";
  explanation: string;
};

const SCORE_DEFINITIONS: ReadonlyArray<Omit<ScoreDimension, "value">> = [
  { key: "brandFit", label: "Brand fit", effect: "adds", explanation: "Keyword overlap between this idea and the written brand brain. It is not a model opinion. Adds to the rank." },
  { key: "historicalEvidence", label: "History", effect: "adds", explanation: "Learned performance lift for this angle or hook. 0 means no stored pattern. Adds to the rank." },
  { key: "marketSignal", label: "Market", effect: "adds", explanation: "Share of stored competitor creatives that use this angle. 0 when no observations are stored. Adds to the rank." },
  { key: "novelty", label: "Novelty", effect: "adds", explanation: "One minus the share of this brand's own creatives that use this angle. Adds to the rank." },
  { key: "reproducibility", label: "Reproducible", effect: "adds", explanation: "How reproducible the idea is from stored templates and the product on file. Adds to the rank." },
  { key: "saturation", label: "Saturation", effect: "subtracts", explanation: "How crowded the angle is among competitor creatives. Subtracts from the rank, so lower is better." },
  { key: "risk", label: "Risk", effect: "subtracts", explanation: "Claim intensity, rejections and negative performance lift. Subtracts from the rank, so lower is better." },
];

export function scoreDimensions(item: Pick<OpportunityRow, ScoreKey>): ScoreDimension[] {
  return SCORE_DEFINITIONS.map((definition) => ({ ...definition, value: finiteOrNull(item[definition.key]) }));
}

/** A plain sentence that gives the same numbers the radar draws, for screen readers and for the chart's label. */
export function scoreSummary(dimensions: readonly ScoreDimension[]): string {
  const parts = dimensions.map((dimension) => `${dimension.label} ${dimension.value === null ? "unknown" : dimension.value.toFixed(2)}`);
  return `Rank parts: ${parts.join(", ")}. Parts that add raise the rank, parts that subtract lower it. Weights are not shown here.`;
}

/**
 * Stored facts that explain why an opportunity is not higher or is held. Each line comes from a stored field.
 * No threshold is invented: a value only appears as a fact when it is present and non-zero.
 */
export function whyNotFacts(item: OpportunityRow): string[] {
  const facts: string[] = [];
  const probability = jevProbability(item);
  if (isHeld(item)) {
    const decided = probability === null ? "Its probability is unknown." : `Its probability is ${percentOrUnknown(probability)}.`;
    facts.push(`On hold: the decision engine asked for a person to review it. ${decided} A person must clear it under Reviews before a brief can be built.`);
  }
  if (item.status === "rejected") facts.push("The decision engine rejected this candidate when it was ranked.");
  if (item.status === "dismissed") facts.push("A person dismissed this opportunity.");
  if (!item.decision) facts.push("No decision yet for this candidate, so its probability is unknown.");
  if (item.evidenceBasis === "none" || item.evidenceBasis === "brand_only") {
    facts.push("Idea to test only: no stored competitor observation or performance pattern backs this angle.");
  }
  const saturation = finiteOrNull(item.saturation);
  if (saturation !== null && saturation > 0) facts.push(`Saturation ${saturation.toFixed(2)} lowers the rank.`);
  const risk = finiteOrNull(item.risk);
  if (risk !== null && risk > 0) facts.push(`Risk ${risk.toFixed(2)} lowers the rank.`);
  return facts;
}
