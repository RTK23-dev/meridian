import type { DecisionState } from "../jev/engine.ts";

/** Both gates have to pass. A missing vision result cannot be overridden by clean text. */
export function routeApproval(text: DecisionState, vision: DecisionState): DecisionState {
  if (text === "REJECT" || vision === "REJECT") return "REJECT";
  if (text === "HUMAN_REVIEW" || vision === "HUMAN_REVIEW") return "HUMAN_REVIEW";
  return "AUTO_APPROVE";
}
