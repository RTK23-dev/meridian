import assert from "node:assert/strict";
import test from "node:test";
import {
  SUBMISSION_EVIDENCE_BOUND_MS,
  classifySubmissionEvidence,
  evidenceFromProviderStatus,
  submissionEvidenceDue,
  type SubmissionEvidence,
} from "./submission-reconciliation.ts";
import { MAX_PROVIDER_POLL_AGE_MS } from "./poller.ts";

const HOUR = 60 * 60 * 1000;
const ACCEPTED: SubmissionEvidence = { kind: "accepted", providerJobId: "req-accepted-1" };
const FAILED: SubmissionEvidence = { kind: "failed", errorCode: "RENDER_REJECTED", reason: "The provider reports the job failed." };
const AMBIGUOUS: SubmissionEvidence = { kind: "ambiguous", errorCode: "PROVIDER_AUTH_REJECTED", reason: "Key refused (HTTP 401)." };
const NONE: SubmissionEvidence = { kind: "none" };

test("the expiry bound is the poller's age bound for unreadable jobs, so both end at twenty-four hours", () => {
  assert.equal(SUBMISSION_EVIDENCE_BOUND_MS, 24 * HOUR);
  assert.equal(SUBMISSION_EVIDENCE_BOUND_MS, MAX_PROVIDER_POLL_AGE_MS);
});

test("accepted evidence with a provider job id is CONFIRMED, however old the job is", () => {
  assert.equal(classifySubmissionEvidence({ evidence: ACCEPTED, ageMs: 0 }), "CONFIRMED");
  assert.equal(classifySubmissionEvidence({ evidence: ACCEPTED, ageMs: 48 * HOUR }), "CONFIRMED");
});

test("accepted evidence without a usable provider job id is REVIEW, never CONFIRMED", () => {
  assert.equal(classifySubmissionEvidence({ evidence: { kind: "accepted", providerJobId: "   " }, ageMs: 0 }), "REVIEW");
});

test("a provider's failure is FAILED, at any age", () => {
  assert.equal(classifySubmissionEvidence({ evidence: FAILED, ageMs: 0 }), "FAILED");
  assert.equal(classifySubmissionEvidence({ evidence: FAILED, ageMs: 48 * HOUR }), "FAILED");
});

test("an ambiguous answer is REVIEW, at any age", () => {
  assert.equal(classifySubmissionEvidence({ evidence: AMBIGUOUS, ageMs: 0 }), "REVIEW");
  assert.equal(classifySubmissionEvidence({ evidence: AMBIGUOUS, ageMs: 48 * HOUR }), "REVIEW");
});

test("no evidence is EXPIRED at the bound, and not before it", () => {
  assert.equal(classifySubmissionEvidence({ evidence: NONE, ageMs: SUBMISSION_EVIDENCE_BOUND_MS - 1 }), "REVIEW");
  assert.equal(classifySubmissionEvidence({ evidence: NONE, ageMs: SUBMISSION_EVIDENCE_BOUND_MS }), "EXPIRED");
  assert.equal(classifySubmissionEvidence({ evidence: NONE, ageMs: 25 * HOUR }), "EXPIRED");
});

test("the pass acts on any evidence at once, and waits for missing evidence inside the bound", () => {
  assert.equal(submissionEvidenceDue({ evidence: ACCEPTED, ageMs: 0 }), true);
  assert.equal(submissionEvidenceDue({ evidence: FAILED, ageMs: 0 }), true);
  assert.equal(submissionEvidenceDue({ evidence: AMBIGUOUS, ageMs: 0 }), true);
  assert.equal(submissionEvidenceDue({ evidence: NONE, ageMs: HOUR }), false);
  assert.equal(submissionEvidenceDue({ evidence: NONE, ageMs: SUBMISSION_EVIDENCE_BOUND_MS }), true);
});

test("a provider status that names the job as accepted is accepted evidence under the stored id", () => {
  for (const status of ["QUEUED", "RUNNING", "RENDERING", "RENDERED", "COMPLETED"]) {
    assert.deepEqual(evidenceFromProviderStatus({ status, providerJobId: "req-1" }), { kind: "accepted", providerJobId: "req-1" }, status);
  }
});

test("a failed status is failed evidence, carrying the provider's code, or PROVIDER_FAILED without one", () => {
  assert.deepEqual(evidenceFromProviderStatus({ status: "FAILED", providerJobId: "req-1", errorCode: "NSFW", error: "Rejected." }), {
    kind: "failed",
    errorCode: "NSFW",
    reason: "The provider reports the job failed: Rejected.",
  });
  const bare = evidenceFromProviderStatus({ status: "FAILED", providerJobId: "req-1" });
  assert.equal(bare.kind, "failed");
  assert.equal(bare.kind === "failed" && bare.errorCode, "PROVIDER_FAILED");
});

test("any other status is ambiguous, so it is never read as acceptance", () => {
  for (const status of ["SUBMITTING", "SUBMISSION_UNKNOWN", "CANCELLED", "PREFLIGHT_FAILED", "NOT_CONFIGURED", "something-new"]) {
    assert.equal(evidenceFromProviderStatus({ status, providerJobId: "req-1" }).kind, "ambiguous", status);
  }
});

test("an accepted status with no stored provider id is ambiguous, not confirmed", () => {
  assert.equal(evidenceFromProviderStatus({ status: "RUNNING", providerJobId: "  " }).kind, "ambiguous");
});
