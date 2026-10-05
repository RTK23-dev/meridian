import { hasWord, splitTerms } from "../domain.ts";
import type { TextQaInput } from "../jev/questions.ts";

const UNSUPPORTED_PHRASES = [
  "clinically proven",
  "guaranteed results",
  "doctor approved",
  "risk-free",
  "risk free",
  "miracle",
  "cures",
  "cure",
  "100%",
  "#1",
];

export type GuardianTextInput = {
  text: string;
  productName: string;
  allowedClaims: string;
  prohibitedClaims: string;
  requiredDisclaimers: string;
  wordsToAvoid: string;
  hook: string;
  cta: string;
};

/** Structured evidence for JEV. This function does not decide approve or reject. */
export function guardianTextEvidence(input: GuardianTextInput): TextQaInput {
  const text = input.text.toLowerCase();
  const allowed = input.allowedClaims.toLowerCase();
  const prohibitedHits = splitTerms(input.prohibitedClaims).filter((term) => text.includes(term.toLowerCase()));
  const unsupportedClaimHits = UNSUPPORTED_PHRASES.filter((phrase) => {
    if (!text.includes(phrase)) return false;
    return !allowed.includes(phrase);
  });
  const missingDisclaimers = splitTerms(input.requiredDisclaimers).filter(
    (term) => !text.includes(term.toLowerCase()),
  );
  const avoidedWordHits = splitTerms(input.wordsToAvoid).filter((term) => hasWord(input.text, term));
  const productRequired = input.productName.trim().length >= 2;
  const productMentioned = productRequired && text.includes(input.productName.trim().toLowerCase());
  return {
    prohibitedHits,
    unsupportedClaimHits,
    missingDisclaimers,
    avoidedWordHits,
    productRequired,
    productMentioned,
    hasHook: input.hook.trim().length >= 2,
    hasCta: input.cta.trim().length >= 2,
    toneConflict: avoidedWordHits.length > 0,
  };
}

export function rejectionCode(evidence: TextQaInput): string {
  if (evidence.prohibitedHits.length > 0) return "prohibited_claim";
  if (evidence.unsupportedClaimHits.length > 0) return "unsupported_claim";
  if (evidence.productRequired && !evidence.productMentioned) return "wrong_product";
  if (evidence.missingDisclaimers.length > 0) return "missing_disclosure";
  if (evidence.toneConflict) return "tone_mismatch";
  if (!evidence.hasHook || !evidence.hasCta) return "poor_brief";
  return "other";
}
