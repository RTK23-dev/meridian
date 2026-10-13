import { guardianTextEvidence, rejectionCode, type GuardianTextInput } from "../guardian/text.ts";
import { copyClaimRejections, type DeterministicRejection } from "../decisions/deterministic.ts";
import type { GateEvidenceInput, GateResult } from "../decisions/gate.ts";
import type { DecisionEngineRegistry } from "../decisions/dispatcher.ts";
import type { EngineSelection } from "../decisions/selection.ts";
import type { Sql } from "../learning/store.ts";
import { decide, type DecisionOutput, type DecisionState } from "../jev/engine.ts";
import { creativeQa, type TextQaInput } from "../jev/questions.ts";
import { CREATIVE_EVIDENCE_SCOPES, CREATIVE_QUESTIONS } from "../jev/questions/creative.ts";

/**
 * The copy check. The score and the reasons come from the QA question. The rejection comes from the shared deterministic rule
 * (decisions/deterministic.ts): a prohibited or an unsupported claim rejects, whatever the score. Without that rule firing, the
 * copy goes to review, because a rule score is uncalibrated and cannot approve.
 *
 * This function is synchronous and makes no engine call. The claim judgment is added by `judgeCopy`.
 */
export function assessCopy(input: GuardianTextInput): {
  evidence: TextQaInput;
  decision: DecisionOutput;
  reasonCode: string | null;
} {
  const evidence = guardianTextEvidence(input);
  const scored = decide(creativeQa, evidence);
  const rejections = copyClaimRejections(evidence);
  const decision: DecisionOutput = rejections.length > 0 ? { ...scored, decision: "REJECT" } : scored;
  return {
    evidence,
    decision,
    reasonCode: decision.decision === "REJECT" ? rejectionCode(evidence) : null,
  };
}

/** The existing creative claim question. The copy check asks it through the engine gate. It is not a new question. */
export const COPY_CLAIM_QUESTION_ID = "creative.claim_compliance.v1";

/**
 * How the claim was judged.
 * - passed: a calibrated engine answer approved it through the gate.
 * - review: the engine answered, but the answer is uncalibrated or below the approval line, so a person decides.
 * - rejected: a deterministic rule or a calibrated engine answer rejected it.
 * - not_judged: no engine answered (none configured, a provider failure, or missing evidence). It is shown as not judged, never as passed.
 */
export type ClaimJudgment = "passed" | "review" | "rejected" | "not_judged";

export type ClaimCheck = {
  judgment: ClaimJudgment;
  /** The decision this judgment gives the copy. `passed` is a ceiling only: the copy's own QA still has to agree. */
  decision: DecisionState;
  reason: string;
  /** The gate's result for the claim. Null when no gate call was made, which happens only for a check with no brand. */
  gate: GateResult | null;
};

export type JudgeCopyInput = {
  copy: GuardianTextInput;
  sql?: Sql;
  organizationId: string;
  /** The brand the copy belongs to. Null means the check has no brand, so no brand claim facts exist and no claim question is asked. */
  brandId: string | null;
  /** What the copy belongs to. Recorded on the gate record. */
  subject: { type: string; id: string };
  /** The engine selection the caller resolved. When absent, the gate resolves the workspace's engine. */
  selection?: EngineSelection;
  /** Engine transports. Tests inject fakes here. Production leaves it absent. */
  engines?: DecisionEngineRegistry;
};

export type JudgedCopy = {
  evidence: TextQaInput;
  /** The copy decision, with the claim check applied. A claim check can add a block but never remove one. */
  decision: DecisionOutput;
  reasonCode: string | null;
  claim: ClaimCheck;
};

/**
 * The copy check with its claim judgment. The deterministic rules run first, as in `assessCopy`. The claim question then goes
 * through the shared engine gate, which applies the rules again before any engine call. The gate never approves an uncalibrated
 * answer, so an uncalibrated claim goes to review, and a claim with no engine answer is not judged.
 */
export async function judgeCopy(input: JudgeCopyInput): Promise<JudgedCopy> {
  const assessed = assessCopy(input.copy);
  const claim = await judgeClaim(input, assessed.evidence);
  const decision = applyClaimCheck(assessed.decision, claim);
  return {
    evidence: assessed.evidence,
    decision,
    reasonCode: copyReasonCode(decision.decision, assessed.evidence, claim),
    claim,
  };
}

const SEVERITY: Record<DecisionState, number> = { AUTO_APPROVE: 0, HUMAN_REVIEW: 1, REJECT: 2 };

const DECISION_OF_JUDGMENT: Record<ClaimJudgment, DecisionState> = {
  passed: "AUTO_APPROVE",
  review: "HUMAN_REVIEW",
  not_judged: "HUMAN_REVIEW",
  rejected: "REJECT",
};

/**
 * Adds a claim check to a copy decision. The more severe of the two stands. So a rejection from the copy rules stays a rejection,
 * a claim that was not judged keeps the copy out of approval, and a passed claim can only go as far as the copy's own QA allows.
 */
export function applyClaimCheck(decision: DecisionOutput, claim: ClaimCheck): DecisionOutput {
  const worst = SEVERITY[claim.decision] > SEVERITY[decision.decision] ? claim.decision : decision.decision;
  return { ...decision, decision: worst, reasons: [...decision.reasons, claim.reason] };
}

/** The reason code of a rejected copy. A rule hit names its rule. An engine rejection with no rule hit is an unsupported claim. */
export function copyReasonCode(decision: DecisionState, evidence: TextQaInput, claim: ClaimCheck): string | null {
  if (decision !== "REJECT") return null;
  const ruleHit = evidence.prohibitedHits.length > 0 || evidence.unsupportedClaimHits.length > 0;
  if (!ruleHit && claim.judgment === "rejected") return "unsupported_claim";
  return rejectionCode(evidence);
}

async function judgeClaim(input: JudgeCopyInput, evidence: TextQaInput): Promise<ClaimCheck> {
  const rejections: DeterministicRejection[] = copyClaimRejections(evidence);
  if (input.brandId === null) {
    // No brand means no brand facts, so no claim question is asked. A rule hit still rejects, because the rule decides.
    if (rejections.length > 0) {
      return claimCheck("rejected", `Claim rule: ${rejections.map((entry) => entry.reason).join(" ")}`, null);
    }
    return claimCheck("not_judged", "Claim not judged: this check has no brand, so there are no brand claim facts to judge against.", null);
  }

  // Only evidence that exists is passed. A blank brand fact is not evidence, so the question abstains and the claim is not judged.
  const items: GateEvidenceInput[] = [];
  if (input.copy.text.trim()) {
    items.push({ kind: "text", name: "creative_copy", source: "copy", content: { text: input.copy.text } });
  }
  if (input.copy.prohibitedClaims.trim()) {
    items.push({
      kind: "text",
      name: "brand_prohibited_claims",
      source: "brand_brain",
      content: { prohibitedClaims: input.copy.prohibitedClaims },
    });
  }

  // Loaded when a claim is judged, not at import. The gate reaches the engine clients, which use Node's crypto, and this module is
  // also loaded by the browser through the Studio actions. A top-level import would run that code in the page.
  const { runEngineGate } = await import("../decisions/gate.ts");
  const spec = CREATIVE_QUESTIONS[COPY_CLAIM_QUESTION_ID];
  const gate = await runEngineGate({
    sql: input.sql,
    organizationId: input.organizationId,
    brandId: input.brandId,
    gate: "copy",
    subject: input.subject,
    description: "Production copy under check. Judge only the copy and the brand's stored prohibited claims that are provided.",
    questions: [
      {
        key: spec.id,
        spec,
        needsImage: false,
        evidenceScope: CREATIVE_EVIDENCE_SCOPES[COPY_CLAIM_QUESTION_ID],
      },
    ],
    evidence: items,
    deterministicRejections: rejections,
    selection: input.selection,
    engines: input.engines,
  });
  return claimFromGate(gate);
}

function claimFromGate(gate: GateResult): ClaimCheck {
  if (gate.action === "REJECT") return claimCheck("rejected", `Claim rejected: ${gate.reason}`, gate);
  if (gate.action === "AUTO_APPROVE") return claimCheck("passed", `Claim passed the engine gate: ${gate.reason}`, gate);
  // The gate sends a non-approval to review. Only an answered claim was judged. Anything else was not judged.
  if (gate.answers[COPY_CLAIM_QUESTION_ID]?.status === "answered") {
    return claimCheck("review", `Claim routed to human review, not passed: ${gate.reason}`, gate);
  }
  return claimCheck("not_judged", `Claim not judged: ${gate.reason}`, gate);
}

function claimCheck(judgment: ClaimJudgment, reason: string, gate: GateResult | null): ClaimCheck {
  return { judgment, decision: DECISION_OF_JUDGMENT[judgment], reason, gate };
}
