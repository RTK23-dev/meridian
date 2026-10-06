import type { Thresholds } from "./propose.ts";

export function approvedThresholds(
  fallback: { autoApprove: number; humanReview: number; minConfidenceForAuto: number },
  stored: { thresholds: string } | null,
): { autoApprove: number; humanReview: number; minConfidenceForAuto: number; source: "code" | "approved" } {
  if (!stored?.thresholds) return { ...fallback, source: "code" };
  let parsed: Partial<Thresholds>;
  try {
    parsed = JSON.parse(stored.thresholds) as Partial<Thresholds>;
  } catch {
    return { ...fallback, source: "code" };
  }
  if (typeof parsed.autoApprove !== "number" || typeof parsed.humanReview !== "number") return { ...fallback, source: "code" };
  return {
    autoApprove: parsed.autoApprove,
    humanReview: parsed.humanReview,
    minConfidenceForAuto: fallback.minConfidenceForAuto,
    source: "approved",
  };
}
