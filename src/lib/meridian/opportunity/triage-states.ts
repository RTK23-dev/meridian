// The triage states of an opportunity (prompt 13). An open idea can be declined, or held: saved for later, deferred, or sent back for more
// research. A held idea leaves the open list with a recorded reason, and reopen returns it. Each action names the status it leaves and the
// statuses it may leave from. Approving a direction stays on Studio's decision path, so the Opportunities screen does not offer it.

export const DIRECTION_ACTIONS = ["approve", "decline", "save", "defer", "request_research", "reopen"] as const;
export type DirectionAction = (typeof DIRECTION_ACTIONS)[number];

/** The actions the Opportunities screen offers. */
export const TRIAGE_ACTIONS = ["decline", "save", "defer", "request_research", "reopen"] as const;
export type TriageAction = (typeof TRIAGE_ACTIONS)[number];

export const HELD_STATUSES = ["saved", "deferred", "needs_research"] as const;
export type HeldStatus = (typeof HELD_STATUSES)[number];

const STATUS_AFTER: Record<DirectionAction, string> = {
  approve: "accepted",
  decline: "dismissed",
  save: "saved",
  defer: "deferred",
  request_research: "needs_research",
  reopen: "open",
};

export function isDirectionAction(value: string): value is DirectionAction {
  return (DIRECTION_ACTIONS as readonly string[]).includes(value);
}

export function isHeldStatus(status: string): status is HeldStatus {
  return (HELD_STATUSES as readonly string[]).includes(status);
}

/** The status an action leaves the opportunity in. */
export function statusAfter(action: DirectionAction): string {
  return STATUS_AFTER[action];
}

/** The refusal for an action that cannot leave the opportunity's current status, or null when it may. */
export function sourceStatusProblem(action: DirectionAction, status: string): string | null {
  if (action === "approve" || action === "decline") {
    return status === "open" || status === "accepted"
      ? null
      : "This opportunity was rejected, dismissed, or already briefed, so its direction cannot be decided now.";
  }
  if (action === "reopen") return isHeldStatus(status) ? null : "Only a saved, deferred or needs-research idea can be reopened.";
  return status === "open" ? null : "Only an open idea can be saved, deferred or sent for more research.";
}

/** The triage actions an opportunity in this status offers (empty when it has none). */
export function triageActionsFor(status: string): TriageAction[] {
  if (status === "open") return ["decline", "save", "defer", "request_research"];
  if (status === "accepted") return ["decline"];
  if (isHeldStatus(status)) return ["reopen"];
  return [];
}

/**
 * The statuses an idea can be made into a brief from. A declined idea (rejected, dismissed) is not briefed, and an idea that needs research is
 * not yet read. A briefed idea may be briefed again: that is a second video from the same idea.
 */
export const BRIEFABLE_STATUSES = ["open", "accepted", "saved", "deferred", "briefed"] as const;

export function canMakeBrief(status: string): boolean {
  return (BRIEFABLE_STATUSES as readonly string[]).includes(status);
}
