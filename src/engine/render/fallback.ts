// The render fallback policy (Bible 6.11 as amended; owner decision 2026-10-14). HyperFrames is tried twice. After two
// failures, a component-free EDL goes to Shotstack, and any other EDL goes to review. Shotstack is tried once.
//
// A render failure is a provider error: a rejected or failed submit, a failed render, an integrity miss, or a dropped
// connection (guardTransport makes that a provider error). Anything else (a budget refusal, a missing key, an invalid
// composition or EDL, a bug) is not a render failure. It is thrown at once, so no other renderer spends money on it.
//
// The decision is pure (nextRenderStep). renderWithFallback runs the attempts the caller injects; the caller compiles
// the EDL and calls renderComposition or renderEdlWithShotstack. No model calls, and the same inputs give the same route.

import { EngineError, type EditDecisionList } from "../contracts/index.ts";
import type { RenderOutcome } from "./hyperframesCloud.ts";
import { isComponentFree, type ShotstackRenderOutcome } from "./shotstack.ts";

/** Bible 6.11: "On two failures, falls back to Shotstack for component-free timelines". */
export const HYPERFRAMES_ATTEMPT_LIMIT = 2;

export type RenderRoute = "hyperframes" | "shotstack";

/** One failed attempt, kept for the manifest. */
export type RenderFailure = {
  route: RenderRoute;
  attempt: number;
  message: string;
  retryable: boolean;
  stage: string | undefined;
};

/** Why the render went to review: the EDL has a custom component, or every renderer that could take it failed. */
export type ReviewReason = "custom_components" | "renderers_failed";

export type NextRenderStep =
  | { next: "hyperframes"; attempt: number }
  | { next: "shotstack" }
  | { next: "review"; reason: ReviewReason };

/** The next step given the failures so far. Pure: no I/O, no clock. */
export function nextRenderStep(input: { failures: readonly RenderFailure[]; componentFree: boolean }): NextRenderStep {
  const hyperframesFailures = input.failures.filter((failure) => failure.route === "hyperframes").length;
  if (hyperframesFailures < HYPERFRAMES_ATTEMPT_LIMIT) {
    return { next: "hyperframes", attempt: hyperframesFailures + 1 };
  }
  if (!input.componentFree) {
    return { next: "review", reason: "custom_components" };
  }
  const shotstackFailures = input.failures.filter((failure) => failure.route === "shotstack").length;
  if (shotstackFailures === 0) {
    return { next: "shotstack" };
  }
  return { next: "review", reason: "renderers_failed" };
}

/** True for a provider error, the only error that counts as a failed render. Every other error stops the chain. */
export function isRenderFailure(error: unknown): error is EngineError {
  return error instanceof EngineError && error.kind === "provider";
}

export type FallbackAttempts = {
  /** One HyperFrames attempt: compile, then renderComposition. Resolves with a passing video, or throws. */
  hyperframes: (attempt: number) => Promise<RenderOutcome>;
  /** One Shotstack attempt. Called only for a component-free EDL. */
  shotstack: () => Promise<ShotstackRenderOutcome>;
};

export type FallbackResult =
  | { status: "rendered"; route: "hyperframes"; outcome: RenderOutcome; failures: RenderFailure[] }
  | { status: "rendered"; route: "shotstack"; outcome: ShotstackRenderOutcome; failures: RenderFailure[] }
  | { status: "review"; reason: ReviewReason; failures: RenderFailure[] };

/**
 * Renders an EDL with the policy: HyperFrames twice, then Shotstack for a component-free EDL, else review. A review is a
 * result, not an exception: the caller creates the review item (Bible 5.3) and records the failures.
 */
export async function renderWithFallback(edl: EditDecisionList, attempts: FallbackAttempts): Promise<FallbackResult> {
  const componentFree = isComponentFree(edl);
  const failures: RenderFailure[] = [];
  // Each pass either returns or adds one failure, and the policy allows at most three renders, so the loop ends.
  for (;;) {
    const step = nextRenderStep({ failures, componentFree });
    if (step.next === "review") {
      return { status: "review", reason: step.reason, failures };
    }
    try {
      if (step.next === "hyperframes") {
        const outcome = await attempts.hyperframes(step.attempt);
        return { status: "rendered", route: "hyperframes", outcome, failures };
      }
      const outcome = await attempts.shotstack();
      return { status: "rendered", route: "shotstack", outcome, failures };
    } catch (error) {
      if (!isRenderFailure(error)) throw error;
      failures.push({
        route: step.next === "hyperframes" ? "hyperframes" : "shotstack",
        attempt: step.next === "hyperframes" ? step.attempt : 1,
        message: error.message,
        retryable: error.retryable,
        stage: error.stage,
      });
    }
  }
}
