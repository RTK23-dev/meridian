export const DAILY_GENERATION_LIMIT = 40;
export const GENERATION_CONCURRENCY = 3;

/** Blocks a run before any provider call. Cost stays unknown until a provider returns one. */
export function generationAllowed(input: { runsToday: number; running: number }): {
  allowed: boolean;
  reason: string;
  estimatedCostCents: null;
} {
  if (!Number.isFinite(input.running) || input.running >= GENERATION_CONCURRENCY) {
    return {
      allowed: false,
      estimatedCostCents: null,
      reason: `Generation is already running ${input.running} time(s) in this workspace. The concurrency limit is ${GENERATION_CONCURRENCY}. Nothing was created.`,
    };
  }
  if (!Number.isFinite(input.runsToday) || input.runsToday >= DAILY_GENERATION_LIMIT) {
    return {
      allowed: false,
      estimatedCostCents: null,
      reason: `This workspace has used ${input.runsToday} generation runs in the last day. The limit is ${DAILY_GENERATION_LIMIT}. Nothing was created.`,
    };
  }
  return { allowed: true, reason: "", estimatedCostCents: null };
}
