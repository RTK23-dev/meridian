// The approval of a delivered video (prompt 16). A person approves or rejects the video the engine delivered. A decision belongs to the engine
// request it was made on: a revision is a new request, so it starts with no decision, and the decisions on the earlier videos stay in the
// history. The latest decision on the current video is its state. A later decision may change an earlier one, and both stay on record.
//
// Publishing is not connected in this build (no publishing connector exists), so the publish state says so. A video is measured only after
// it is published through a connected channel, so the measurement state says it is not measured. Neither is shown as a success.

export const APPROVAL_DECISIONS = ["approved", "rejected"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export const REJECT_REASON_MIN = 10;
export const APPROVAL_NOTE_MAX = 500;

export type ApprovalRecord = {
  engineRequestId: string;
  decision: ApprovalDecision;
  reason: string;
  actorId: string;
  createdAt: string;
};

export type ApprovalState =
  | { status: "not_decided" }
  | { status: ApprovalDecision; decidedAt: string; actorId: string; reason: string };

export function isApprovalDecision(value: string): value is ApprovalDecision {
  return (APPROVAL_DECISIONS as readonly string[]).includes(value);
}

/** The first problem with a decision in plain words, or null. A rejection needs its reason; an approval may carry a note. */
export function approvalProblem(input: { decision: string; reason: string }): string | null {
  if (!isApprovalDecision(input.decision)) return "Choose approve or reject.";
  const reason = input.reason.trim();
  if (reason.length > APPROVAL_NOTE_MAX) return `The note is longer than ${APPROVAL_NOTE_MAX} characters.`;
  if (input.decision === "rejected" && reason.length < REJECT_REASON_MIN) {
    return `Say why the video is rejected, in at least ${REJECT_REASON_MIN} characters. The reason stays on record.`;
  }
  return null;
}

/** The state of one delivered video: the latest decision made on its request, or not decided. Records are in the order they were made. */
export function approvalStateFor(records: readonly ApprovalRecord[], engineRequestId: string): ApprovalState {
  const latest = records.filter((record) => record.engineRequestId === engineRequestId).at(-1);
  if (!latest) return { status: "not_decided" };
  return { status: latest.decision, decidedAt: latest.createdAt, actorId: latest.actorId, reason: latest.reason };
}

export type PublishState = { status: "not_connected"; reason: string };

/** The publish state of a session's video. No publishing connector exists in this build, so it is never reported as published. */
export function publishStateOf(): PublishState {
  return {
    status: "not_connected",
    reason: "No publishing channel is connected for this workspace, so an approved video cannot be published from here yet.",
  };
}
