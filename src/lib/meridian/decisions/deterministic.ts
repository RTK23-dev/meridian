/**
 * Deterministic rejections shared by every gate that checks copy or a brief. A rejection here is decided by code, before any
 * engine is called, and no engine answer can override it. The gate (gate.ts) takes these as `deterministicRejections`, and a
 * copy check reads the same rule names, so one rule decides a prohibited claim wherever it is found.
 */

export type DeterministicRejection = { rule: string; reason: string };

export const PROHIBITED_CLAIM_RULE = "prohibited_claim";
export const UNSUPPORTED_CLAIM_RULE = "unsupported_claim";

/**
 * The first stored prohibited term that appears in the text, as a rejection. The terms are matched case-insensitively. The
 * caller decides how the stored text is split into terms, so each surface keeps its own parsing.
 */
export function prohibitedClaimRejection(text: string, terms: readonly string[]): DeterministicRejection | null {
  const lower = text.toLowerCase();
  const hit = terms.map((term) => term.trim()).find((term) => term.length > 0 && lower.includes(term.toLowerCase()));
  if (hit === undefined) return null;
  return { rule: PROHIBITED_CLAIM_RULE, reason: `The text contains the stored prohibited claim “${hit}”.` };
}

/** The rejections a checked copy earns from its claim evidence. A prohibited or an unsupported claim is a rejection. */
export function copyClaimRejections(evidence: { prohibitedHits: readonly string[]; unsupportedClaimHits: readonly string[] }): DeterministicRejection[] {
  const rejections: DeterministicRejection[] = [];
  if (evidence.prohibitedHits.length > 0) {
    rejections.push({ rule: PROHIBITED_CLAIM_RULE, reason: `Prohibited language: ${evidence.prohibitedHits.join(", ")}` });
  }
  if (evidence.unsupportedClaimHits.length > 0) {
    rejections.push({ rule: UNSUPPORTED_CLAIM_RULE, reason: `Unsupported claim language: ${evidence.unsupportedClaimHits.join(", ")}` });
  }
  return rejections;
}
