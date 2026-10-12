/**
 * The Factory steps a person approves, and what a run in each state says to the person. Pure: the server function and the
 * Factory screen read the same rule, so a button shows only where the server would accept the approval.
 */

/** The steps that wait for a person in manual and semi automation. Each one spends, publishes or commits a choice. */
export const APPROVABLE_STAGES = ["factory.produce", "factory.launch", "factory.test", "factory.review"] as const;

export type ApprovableStage = (typeof APPROVABLE_STAGES)[number];

export function isApprovableStage(stage: string): stage is ApprovableStage {
  return (APPROVABLE_STAGES as readonly string[]).includes(stage);
}

/** The button label for each approvable step, in the words the Factory line uses. */
export const APPROVAL_LABELS: Record<ApprovableStage, string> = {
  "factory.produce": "Approve production",
  "factory.launch": "Approve launch",
  "factory.test": "Approve budget testing",
  "factory.review": "Approve the review",
};

/**
 * The step a run is waiting on, or null. A run waits only when its status is awaiting_approval and the step it stopped at
 * is one a person can approve. A paused or stopped run has nothing to approve: it needs its cap or the kill switch cleared.
 */
export function pendingApproval(run: { status: string; stage: string }): ApprovableStage | null {
  if (run.status !== "awaiting_approval") return null;
  return isApprovableStage(run.stage) ? run.stage : null;
}

const RUN_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  awaiting_approval: "Waiting for your approval",
  paused: "Paused",
  succeeded: "Finished",
  failed: "Failed",
};

/** A run status in plain words. An unknown status is shown as it is stored, never as a guess. */
export function runStatusLabel(status: string): string {
  return RUN_STATUS_LABELS[status] ?? status;
}
