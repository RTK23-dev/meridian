import type { LearnedPattern } from "../domain.ts";

/**
 * Brand patterns always apply.
 * Organization patterns apply only when this brand opted in.
 * Global patterns never apply. They must not silently change a brand.
 */
export function eligiblePatterns(patterns: LearnedPattern[], useOrganizationLearning = false): LearnedPattern[] {
  return patterns.filter((pattern) => {
    const scope = pattern.scope ?? "brand";
    if (scope === "global") return false;
    if (scope === "organization") return useOrganizationLearning;
    return true;
  });
}
