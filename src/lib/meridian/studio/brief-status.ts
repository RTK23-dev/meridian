/**
 * The brief status rules. This module has no server imports, so the client bundle can import the route tree through the
 * creative and opportunity actions. The brief review module re-exports these names. A brief awaiting review or rejected never
 * reaches production, whichever path created it.
 */
import type { PolicyOutcome } from "../decisions/policy.ts";

export type BriefStatus = "ready" | "awaiting_review" | "rejected";

/** The status a brief takes from its gate outcome. Only an automatic approval is ready without a person. */
export function briefStatusFor(action: PolicyOutcome): BriefStatus {
  if (action === "AUTO_APPROVE") return "ready";
  if (action === "HUMAN_REVIEW") return "awaiting_review";
  return "rejected";
}

/**
 * Why a brief cannot be made into a creative, or null when it can. Only a ready or used brief is allowed. Anything else is
 * refused, and an unknown status is refused rather than allowed.
 */
export function productionRefusalFor(status: string): string | null {
  if (status === "ready" || status === "used") return null;
  if (status === "awaiting_review") {
    return "This brief is awaiting review. An admin or owner must review it before a creative is made from it.";
  }
  if (status === "rejected") return "This brief did not pass the gate.";
  return "This brief is not ready for production.";
}
