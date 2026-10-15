// The Instagram candidates a Factory run gathered, as the board shows them (B2). Pure types and constants, so the client view can
// import them; the query that reads them is candidates.ts. A tier is shown only when the rater gave one; otherwise the reason says
// why the reel is not rated.

export type CandidateTier = "S" | "A" | "B" | "C";

export type RunCandidate = {
  id: string;
  permalink: string;
  creatorHandle: string;
  /** The reel's view count at its latest checkpoint, or null when no source reported it. */
  views: number | null;
  /** The creator's median views the reel is rated against, or null when the baseline is missing. */
  creatorMedianViews: number | null;
  /** The tier, or null when the reel is not rated. */
  tier: CandidateTier | null;
  /** Why the reel is not rated, in words. Empty when it has a tier. */
  reason: string;
};

export type RunCandidateSummary = {
  /** Every candidate the run stored. */
  total: number;
  /** How many candidates are in each tier, and how many are not rated. */
  tiers: Record<CandidateTier | "notRated", number>;
  /** The newest candidates of the run, up to CANDIDATES_SHOWN_PER_RUN. */
  shown: RunCandidate[];
};

/** The candidates the board lists under each run. The rest are counted, not listed. */
export const CANDIDATES_SHOWN_PER_RUN = 25;

export const NO_CANDIDATES: RunCandidateSummary = {
  total: 0,
  tiers: { S: 0, A: 0, B: 0, C: 0, notRated: 0 },
  shown: [],
};
