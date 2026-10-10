/**
 * Evidence contracts: which observed facts a visual question needs before JEV may judge it from text. A question's contract
 * is versioned with the question. If any required fact is unknown for any analysed item, the evidence does not support the
 * question, and the decision goes to human review. Nothing is approved on an incomplete description.
 */
import type { MediaObservation } from "./types.ts";

export const PERCEPTION_EVIDENCE_CONTRACT_VERSION = "perception-evidence.v1";

export type EvidenceContract = {
  id: string;
  version: string;
  /** The observation fields the question needs, for every analysed item. */
  fields: Array<keyof MediaObservation & string>;
};

export const PRODUCT_VISIBILITY_CONTRACT: EvidenceContract = {
  id: "product_visibility",
  version: "1.0.0",
  fields: ["productPresence", "productProminence", "productObstructed"],
};

export const VISUAL_QUALITY_CONTRACT: EvidenceContract = {
  id: "visual_quality",
  version: "1.0.0",
  fields: ["sharpness", "lighting", "composition", "legibility", "artifactsVisible"],
};

export const EVIDENCE_CONTRACTS: Record<string, EvidenceContract> = {
  [PRODUCT_VISIBILITY_CONTRACT.id]: PRODUCT_VISIBILITY_CONTRACT,
  [VISUAL_QUALITY_CONTRACT.id]: VISUAL_QUALITY_CONTRACT,
};

export type ContractCheck =
  | { satisfied: true }
  | { satisfied: false; reason: string; missing: Array<{ mediaId: string; timestampMs: number | null; field: string }> };

function known(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** Checks the contract against every observation. No observation at all is not evidence. */
export function checkEvidenceContract(contract: EvidenceContract, observations: MediaObservation[]): ContractCheck {
  if (observations.length === 0) {
    return { satisfied: false, reason: `No observations were produced, so ${contract.id} evidence is missing.`, missing: [] };
  }
  const missing: Array<{ mediaId: string; timestampMs: number | null; field: string }> = [];
  for (const observation of observations) {
    for (const field of contract.fields) {
      if (!known(observation[field as keyof MediaObservation])) {
        missing.push({ mediaId: observation.mediaId, timestampMs: observation.timestampMs, field });
      }
    }
  }
  if (missing.length === 0) return { satisfied: true };
  return {
    satisfied: false,
    reason: `${contract.id} evidence is incomplete: ${missing.length} required fact(s) are unknown.`,
    missing,
  };
}

/**
 * One line per observation with every contracted fact, unknown facts written as `unknown`. JEV reads these lines, so a missing
 * fact is visible to it as missing, not as a negative.
 */
export function contractEvidenceLines(
  contract: EvidenceContract,
  observations: MediaObservation[],
  label: (observation: MediaObservation) => string,
  provenance: string,
): string[] {
  return observations.map((observation) => {
    const facts = contract.fields.map((field) => {
      const value = observation[field as keyof MediaObservation];
      return `${field}=${known(value) ? String(value) : "unknown"}`;
    });
    return `${label(observation)} [${contract.id} ${contract.version}] ${facts.join("; ")}. Basis: inferred from the pixels by ${provenance}.`;
  });
}

/**
 * The evidence item every visual question's observations are placed in. It is one item. Each question's scope decides whether
 * the question receives it, and only a question whose own contract is satisfied has it in scope.
 */
export const PERCEPTION_EVIDENCE_NAME = "perception_observations";

/**
 * The check for one question's contract, by the contract's id. Each visual question names exactly one contract, so its check
 * depends on its own contract only. A contract that is not registered is never satisfied.
 */
export function checkQuestionContract(contractId: string | undefined, observations: MediaObservation[]): ContractCheck {
  const contract = contractId ? EVIDENCE_CONTRACTS[contractId] : undefined;
  if (!contract) {
    return { satisfied: false, reason: `No evidence contract named ${contractId ?? "(none)"} is registered.`, missing: [] };
  }
  return checkEvidenceContract(contract, observations);
}

/**
 * The contract lines for one run, for the contracts its observations satisfy in full. A contract the observations do not satisfy
 * contributes no lines at all, so no unknown fact is written out, and no question reads a fact it was not checked on.
 */
export function satisfiedContractLines(
  observations: MediaObservation[],
  label: (observation: MediaObservation) => string,
  provenance: string,
): { satisfied: string[]; lines: Record<string, string[]> } {
  const satisfied: string[] = [];
  const lines: Record<string, string[]> = {};
  for (const contract of Object.values(EVIDENCE_CONTRACTS)) {
    if (!checkEvidenceContract(contract, observations).satisfied) continue;
    satisfied.push(contract.id);
    lines[contract.id] = contractEvidenceLines(contract, observations, label, provenance);
  }
  return { satisfied, lines };
}
