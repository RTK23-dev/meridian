/**
 * The frozen brief-creation and opportunity-direction contract. Every brief-creation path calls `createGatedBrief`. It is
 * the only place a brief row is written, and it writes that row only after the shared brief gate has judged the brief.
 * The rules are in docs/ARCHITECTURE_CONTRACTS.md, sections 3 and 5.
 */
import type { PolicyOutcome } from "../decisions/policy.ts";
import type { BriefGateResult } from "./brief-gate.server.ts";

/** The status a brief is stored with. Only an automatic approval is ready without a person. */
export type BriefStatus = "ready" | "awaiting_review" | "rejected";

/** The fields of a brief row, as the caller built them. The service adds the id, status and decision link. */
export type BriefRecord = {
  opportunityId: string | null;
  title: string;
  audience: string;
  angle: string;
  hook: string;
  message: string;
  offer: string;
  cta: string;
  format: string;
  proofType: string;
  constraints: unknown;
  context: unknown;
  workflow: unknown;
  why: unknown;
  learningNotes: unknown;
  failureNotes: unknown;
};

export type CreateGatedBriefInput = {
  organizationId: string;
  brandId: string;
  createdBy: string;
  brief: BriefRecord;
  /**
   * Runs the shared brief gate for this brief. The service calls it with the brief id it has reserved, so the decision row
   * and the brief row can be linked. It is called before any database write, so no transaction is held during the engine call.
   */
  judge: (briefId: string) => Promise<BriefGateResult>;
};

export type CreateGatedBriefResult = {
  briefId: string;
  decisionId: string;
  action: PolicyOutcome;
  status: BriefStatus;
};

/** An explicit decision about an opportunity's direction. It is recorded with who, when, what and why. */
export type OpportunityDirectionInput = {
  organizationId: string;
  brandId: string;
  opportunityId: string;
  actorId: string;
  actorRole: string;
  action: "approve" | "decline";
  /** Required. At least MIN_DIRECTION_REASON_LENGTH characters after trimming. */
  reason: string;
};

export const MIN_DIRECTION_REASON_LENGTH = 20;
