export type JobPhase = "queued" | "running" | "succeeded" | "retry" | "dead";

/** Next status after one attempt. Backoff is 1s, 2s, 4s… from the clock. */
export function nextJobState(input: {
  attempts: number;
  maxAttempts: number;
  failed: boolean;
  clock: number;
}): { status: JobPhase; attempts: number; runAfter: number; lastErrorKept: boolean } {
  const attempts = input.attempts + 1;
  if (!input.failed) {
    return { status: "succeeded", attempts, runAfter: input.clock, lastErrorKept: false };
  }
  if (attempts >= input.maxAttempts) {
    return { status: "dead", attempts, runAfter: input.clock, lastErrorKept: true };
  }
  return {
    status: "retry",
    attempts,
    runAfter: input.clock + 1000 * 2 ** (attempts - 1),
    lastErrorKept: true,
  };
}
