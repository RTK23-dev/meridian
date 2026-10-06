export const ASSET_STATES = [
  "requested",
  "generated",
  "stored",
  "processing",
  "ready",
  "qa_required",
  "approved",
  "rejected",
  "published",
  "archived",
] as const;

export type AssetState = (typeof ASSET_STATES)[number];

const NEXT: Record<AssetState, AssetState[]> = {
  requested: ["generated", "rejected"],
  generated: ["stored", "rejected"],
  stored: ["processing", "rejected"],
  processing: ["ready", "rejected"],
  ready: ["qa_required"],
  qa_required: ["approved", "rejected"],
  approved: ["published", "archived"],
  rejected: ["archived"],
  published: ["archived"],
  archived: [],
};

export function advanceAsset(current: AssetState, next: AssetState): AssetState {
  if (!NEXT[current].includes(next)) throw new Error(`Asset cannot move from ${current} to ${next}.`);
  return next;
}

export type AssetLineage = {
  brandId: string;
  opportunityId: string;
  briefTitle: string;
  workflowId: string;
  variant: string;
  provider: string;
  model: string;
  promptVersion: string;
  generationRun: string;
  assetVersion: number;
  qaDecision: string;
  reviewDecision: string;
  publicationId: string;
  performanceId: string;
};

export function walkToQa(): AssetState[] {
  const states: AssetState[] = ["requested"];
  let current: AssetState = "requested";
  for (const next of ["generated", "stored", "processing", "ready", "qa_required"] as const) {
    current = advanceAsset(current, next);
    states.push(current);
  }
  return states;
}
