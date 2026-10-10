/**
 * Alternative directions for the Direction step. Pure. The list comes from the stored opportunities; nothing is ranked
 * or invented here. The brief is always written from the recommended direction, so these are for comparison only.
 */

import { IDEA_TO_TEST } from "../../lib/copy.ts";

export type DirectionCandidate = {
  id: string;
  label: string;
  angle: string;
  source: string;
  status: string;
  expectedValue: number;
};

export const ALTERNATIVE_LIMIT = 5;

/** Open opportunities other than the recommended one, highest expected value first. */
export function alternativeDirections<T extends DirectionCandidate>(candidates: readonly T[], recommendedId: string): T[] {
  return candidates
    .filter((candidate) => candidate.status === "open" && candidate.id !== recommendedId)
    .slice()
    .sort((left, right) => right.expectedValue - left.expectedValue)
    .slice(0, ALTERNATIVE_LIMIT);
}

/** The source as a person reads it. A starting idea is an idea to test, and the screen must not call it a finding. */
export function directionSourceLabel(source: string): string {
  return source === "discovered" ? "Discovered from stored evidence" : IDEA_TO_TEST.badge;
}
