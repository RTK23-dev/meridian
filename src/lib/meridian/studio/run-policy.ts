import type { Role } from "../access.ts";

/**
 * Who may start a Studio plan at which autonomy, and how far its spend may go (security review, finding 1). The request names an
 * autonomy and a cap, but neither is trusted alone:
 * - a member may not start a plan more automatic than the brand's default, and may never start one fully automatic;
 * - fully automatic needs an admin and a brand-set spend ceiling;
 * - no plan may ask for more than the brand's ceiling.
 */
export type StudioAutonomy = "manual" | "semi_automatic" | "fully_automatic";

export type StudioRunPolicy = { ok: true; autonomy: StudioAutonomy; maxSpendUsd: number | undefined } | { ok: false; problem: string };

const AUTONOMY_RANK: Record<StudioAutonomy, number> = { manual: 0, semi_automatic: 1, fully_automatic: 2 };

const AUTONOMY_WORDS: Record<StudioAutonomy, string> = {
  manual: "manual",
  semi_automatic: "semi-automatic",
  fully_automatic: "fully automatic",
};

export function resolveStudioRunPolicy(input: {
  role: Role;
  requestedAutonomy: StudioAutonomy | undefined;
  brandAutonomy: StudioAutonomy;
  /** The brand's total spend ceiling in dollars, or null when the brand has not set one. */
  ceilingUsd: number | null;
  requestedMaxSpendUsd: number | undefined;
}): StudioRunPolicy {
  const isAdmin = input.role === "admin" || input.role === "owner";
  const autonomy = input.requestedAutonomy ?? input.brandAutonomy;

  if (!isAdmin && AUTONOMY_RANK[autonomy] > AUTONOMY_RANK[input.brandAutonomy]) {
    return {
      ok: false,
      problem: `Only a brand admin can run a plan more automatically than this brand's default, which is ${AUTONOMY_WORDS[input.brandAutonomy]}.`,
    };
  }
  if (autonomy === "fully_automatic" && !isAdmin) {
    return { ok: false, problem: "Only a brand admin can run a plan fully automatically. Choose manual or semi-automatic." };
  }
  if (autonomy === "fully_automatic" && input.ceilingUsd === null) {
    return { ok: false, problem: "Set a total spend ceiling for this brand in its run settings before a plan runs fully automatically." };
  }
  if (input.ceilingUsd !== null && input.requestedMaxSpendUsd !== undefined && input.requestedMaxSpendUsd > input.ceilingUsd) {
    return { ok: false, problem: `This plan cannot spend more than the brand's ceiling of $${input.ceilingUsd.toFixed(2)}.` };
  }
  return {
    ok: true,
    autonomy,
    maxSpendUsd: input.requestedMaxSpendUsd ?? input.ceilingUsd ?? undefined,
  };
}
