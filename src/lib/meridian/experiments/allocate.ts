export type TrafficVariant = {
  id: string;
  role: "control" | "variant";
  weight: number;
};

export type ExperimentPlan = {
  hypothesis: string;
  primaryMetric: "ctr" | "cvr" | "roas";
  secondaryMetrics: string[];
  attributionWindowDays: number;
  variants: TrafficVariant[];
};

/** Weights are the split. This is not a comparison of two creatives without an allocation. */
export function assertAllocation(variants: TrafficVariant[]): void {
  if (variants.length < 2) throw new Error("An experiment needs a control and at least one variant.");
  if (!variants.some((variant) => variant.role === "control")) throw new Error("An experiment needs a control.");
  const total = variants.reduce((sum, variant) => sum + variant.weight, 0);
  if (Math.abs(total - 1) > 0.001) throw new Error("Traffic weights must sum to 1.");
  if (variants.some((variant) => variant.weight <= 0)) throw new Error("Every variant needs a positive weight.");
}

export function allocateTraffic(variants: TrafficVariant[], bucketKey: string): string {
  assertAllocation(variants);
  let hash = 2166136261;
  for (let index = 0; index < bucketKey.length; index += 1) {
    hash ^= bucketKey.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const point = (hash >>> 0) / 4294967296;
  let cursor = 0;
  for (const variant of variants) {
    cursor += variant.weight;
    if (point < cursor) return variant.id;
  }
  return variants[variants.length - 1]?.id ?? "";
}

export function experimentOutcome(input: {
  impressions: number;
  minImpressions: number;
  controlRate: number | null;
  variantRate: number | null;
}): { status: "insufficient" | "improved" | "not_improved"; reason: string } {
  if (input.impressions < input.minImpressions || input.controlRate === null || input.variantRate === null) {
    return { status: "insufficient", reason: "The sample or a rate is missing. No winner is declared." };
  }
  if (input.variantRate > input.controlRate) {
    return { status: "improved", reason: "The variant rate is higher than the control on the stored rows. This is not a causal certificate." };
  }
  return { status: "not_improved", reason: "The variant did not beat the control on the stored rows." };
}
