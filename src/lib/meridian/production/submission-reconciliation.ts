/**
 * Pure decisions for a production job whose provider submission outcome is unknown (SUBMISSION_UNKNOWN).
 *
 * The poller gathers evidence about such a job (a provider answer for the job's stored provider id, or none), and this module
 * turns that evidence into one outcome. It does no I/O and moves no money. A reservation is never released or settled here:
 * a held reservation is resolved by an operator through security/held-reservations.ts, or released by its window sweep there when
 * the submission has no outcome after its window.
 */

/**
 * How long a job with no provider evidence waits before it is expired. It is the poller's age bound for unreadable jobs, so
 * both bounds end at the same point.
 */
export const SUBMISSION_EVIDENCE_BOUND_MS = 24 * 60 * 60 * 1000;

/** Error codes that put a job in front of a person. A job carrying one is left out of the automated pass. */
export const SUBMISSION_REVIEW_CODE = "SUBMISSION_REVIEW_REQUIRED";
export const SUBMISSION_EXPIRED_CODE = "SUBMISSION_EVIDENCE_EXPIRED";

/** What the poller learned about a job's submission. */
export type SubmissionEvidence =
  /** The provider reports the job as accepted, under this provider job id. */
  | { kind: "accepted"; providerJobId: string }
  /** The provider reports the job as failed. */
  | { kind: "failed"; errorCode: string; reason: string }
  /** The provider answered, but the answer does not settle whether the job was accepted (refused key, unknown id, contract mismatch). */
  | { kind: "ambiguous"; errorCode: string; reason: string }
  /** No answer: the job has no provider id to ask about, or the check failed transiently. */
  | { kind: "none"; errorCode?: string; reason?: string };

/**
 * CONFIRMED: accepted, with a provider job id. The job returns to the queue.
 * FAILED: the provider reports the job failed. The job is failed, and its reservation stays held.
 * EXPIRED: no evidence within the bound. The job is marked for a person.
 * REVIEW: anything ambiguous. The job is marked for a person.
 */
export type SubmissionOutcome = "CONFIRMED" | "FAILED" | "EXPIRED" | "REVIEW";

/** Provider statuses that name a job the provider holds: it was accepted and is still in the provider's pipeline or done. */
const ACCEPTED_STATUSES: ReadonlySet<string> = new Set([
  "QUEUED",
  "RUNNING",
  "RENDERING",
  "WAITING_FOR_ARTIFACT",
  "WAITING_FOR_EXTERNAL_ARTIFACT",
  "RENDERED",
  "PENDING_POSTFLIGHT",
  "COMPLETED",
]);

/**
 * Turns a provider's status answer for a stored provider job id into evidence. Only a status that names the job as accepted
 * confirms it. A failed status is a failure. Any other answer is ambiguous, so it goes to a person rather than being guessed.
 */
export function evidenceFromProviderStatus(answer: {
  status: string;
  providerJobId: string;
  errorCode?: string;
  error?: string;
}): SubmissionEvidence {
  if (answer.status === "FAILED") {
    return {
      kind: "failed",
      errorCode: answer.errorCode || "PROVIDER_FAILED",
      reason: answer.error ? `The provider reports the job failed: ${answer.error}` : "The provider reports the job failed.",
    };
  }
  if (ACCEPTED_STATUSES.has(answer.status)) {
    if (!answer.providerJobId.trim()) {
      return { kind: "ambiguous", errorCode: "PROVIDER_JOB_ID_MISSING", reason: "The provider reports the job accepted, but no provider job id is stored." };
    }
    return { kind: "accepted", providerJobId: answer.providerJobId };
  }
  return {
    kind: "ambiguous",
    errorCode: "PROVIDER_STATUS_UNCLEAR",
    reason: `The provider answered with status '${answer.status}', which does not show whether the job was accepted.`,
  };
}

/**
 * The outcome for one job's evidence. The age is the time since submission, on the database clock.
 *
 * "none" inside the bound is not a decision. The poller waits for it before it classifies, so the REVIEW it gives here is only
 * the value for a caller that did not wait.
 */
export function classifySubmissionEvidence(input: { evidence: SubmissionEvidence; ageMs: number }): SubmissionOutcome {
  const { evidence, ageMs } = input;
  switch (evidence.kind) {
    case "accepted":
      return evidence.providerJobId.trim() ? "CONFIRMED" : "REVIEW";
    case "failed":
      return "FAILED";
    case "ambiguous":
      return "REVIEW";
    case "none":
      return ageMs >= SUBMISSION_EVIDENCE_BOUND_MS ? "EXPIRED" : "REVIEW";
  }
}

/** Whether the poller should classify now. Evidence is classified as soon as it exists; "none" waits for the bound. */
export function submissionEvidenceDue(input: { evidence: SubmissionEvidence; ageMs: number }): boolean {
  return input.evidence.kind !== "none" || input.ageMs >= SUBMISSION_EVIDENCE_BOUND_MS;
}
