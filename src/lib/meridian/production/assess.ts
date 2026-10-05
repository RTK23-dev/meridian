import { guardianTextEvidence, rejectionCode, type GuardianTextInput } from "../guardian/text.ts";
import { decide, type DecisionOutput } from "../jev/engine.ts";
import { creativeQa, type TextQaInput } from "../jev/questions.ts";

export function assessCopy(input: GuardianTextInput): {
  evidence: TextQaInput;
  decision: DecisionOutput;
  reasonCode: string | null;
} {
  const evidence = guardianTextEvidence(input);
  const decision = decide(creativeQa, evidence);
  return {
    evidence,
    decision,
    reasonCode: decision.decision === "REJECT" ? rejectionCode(evidence) : null,
  };
}
