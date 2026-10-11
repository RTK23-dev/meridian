import { guardianTextEvidence, rejectionCode, type GuardianTextInput } from "../guardian/text.ts";
import { copyClaimRejections } from "../decisions/deterministic.ts";
import { decide, type DecisionOutput } from "../jev/engine.ts";
import { creativeQa, type TextQaInput } from "../jev/questions.ts";

/**
 * The copy check. The score and the reasons come from the QA question. The rejection comes from the shared deterministic rule
 * (decisions/deterministic.ts): a prohibited or an unsupported claim rejects, whatever the score. Without that rule firing, the
 * copy goes to review, because a rule score is uncalibrated and cannot approve.
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
