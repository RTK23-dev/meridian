/** Shared records the decision loop reads. Callers must already be tenant-scoped. */

export type CreativeOrigin = "competitor" | "own" | "generated" | "uploaded";

export type AttributeBag = {
  angle: string;
  hookType: string;
  format: string;
  proofType: string;
  offer: string;
  cta: string;
  visualStyle: string;
  platform: string;
  emotion: string;
  productName: string;
};

export type ObservedCreative = AttributeBag & {
  id: string;
  organizationId: string;
  brandId: string;
  origin: CreativeOrigin;
  claim: string;
  text: string;
};

export type PerformanceRow = {
  creativeId: string;
  organizationId: string;
  brandId: string;
  impressions: number;
  clicks: number;
  conversions: number;
  spendCents: number;
  revenueCents: number | null;
};

export type LearningState = "OBSERVED" | "INFERRED" | "VALIDATED";

export type LearnedPattern = {
  attribute: string;
  value: string;
  metric: "ctr" | "cvr" | "roas";
  lift: number;
  sampleSize: number;
  baseline: number;
  observed: number;
  summary: string;
  impressions: number;
  /** Absent on older rows. Treated as INFERRED, not as validated. */
  state?: LearningState;
  clicks?: number;
  conversions?: number;
  spendCents?: number;
  revenueCents?: number;
  organizationId?: string;
  brandId?: string;
  /** Brand scope is used by default. Organization scope applies only after an explicit opt-in. Global never applies. */
  scope?: "brand" | "organization" | "global";
};

export type RejectionFact = {
  reasonCode: string;
  count: number;
};

export type ProductFact = {
  id: string;
  name: string;
  description: string;
  allowedClaims: string;
  prohibitedClaims: string;
};

export type BrainSlice = {
  positioning: string;
  differentiators: string;
  problems: string;
  desires: string;
  objections: string;
  tone: string;
  wordsToAvoid: string;
  preferredFormats: string;
  prohibitedClaims: string;
  requiredDisclaimers: string;
  targetCustomers: string;
  valueProposition: string;
};

export function assertSameTenant(
  records: { organizationId: string; brandId: string }[],
  organizationId: string,
  brandId: string,
): void {
  const foreign = records.find(
    (record) => record.organizationId !== organizationId || record.brandId !== brandId,
  );
  if (foreign) {
    throw new Error("Tenant scope violation.");
  }
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function splitTerms(value: string): string[] {
  return value
    .split(/[\n,;]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

export function hasWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(text);
}

export function brainCorpus(brain: BrainSlice): string {
  return [
    brain.positioning,
    brain.differentiators,
    brain.problems,
    brain.desires,
    brain.objections,
    brain.tone,
    brain.preferredFormats,
    brain.valueProposition,
    brain.targetCustomers,
  ].join("\n");
}
