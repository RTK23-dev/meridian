import type { WhitespaceOpportunity } from "@/lib/meridian/jev/account-engine";

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/** Highest expected win probability first. Unknown values sort last, so they never rank as zero. */
export function rankWhitespace(items: readonly WhitespaceOpportunity[]): WhitespaceOpportunity[] {
  return [...items].sort((left, right) => {
    const a = finite(left.expectedWinProbability);
    const b = finite(right.expectedWinProbability);
    if (a === null && b === null) return left.unsaturatedAngle.localeCompare(right.unsaturatedAngle);
    if (a === null) return 1;
    if (b === null) return -1;
    return b - a || left.unsaturatedAngle.localeCompare(right.unsaturatedAngle);
  });
}
