import { MIN_DIRECTION_REASON_LENGTH } from "../studio/brief-service.contract.ts";

/**
 * Why a direction reason is refused, or null when it is long enough. The reason is trimmed before it is counted.
 * This file has no server imports, so client code can use it. The opportunity actions import it, and the brief service
 * re-exports it.
 */
export function directionReasonProblem(reason: string): string | null {
  if (reason.trim().length >= MIN_DIRECTION_REASON_LENGTH) return null;
  return `Write the reason for this direction (at least ${MIN_DIRECTION_REASON_LENGTH} characters).`;
}
