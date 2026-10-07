export type GateName = "originality" | "brand" | "claims" | "policy" | "rights" | "jev";

export type GateVerdict = {
  gate: GateName;
  result: "pass" | "block" | "review";
  reason: string;
};

export type OriginalityInput = {
  frameHashDistance: number | null;
  embeddingDistance: number | null;
  textSimilarity: number | null;
};

export function originalityGate(input: OriginalityInput): GateVerdict {
  if (input.frameHashDistance == null && input.embeddingDistance == null && input.textSimilarity == null) {
    return { gate: "originality", result: "review", reason: "No similarity evidence is stored. The variant is not approved from a missing comparison." };
  }
  if (input.frameHashDistance != null && input.frameHashDistance < 8) {
    return { gate: "originality", result: "block", reason: "Frame similarity to the source ad is too close. Offending beats must be regenerated." };
  }
  if (input.embeddingDistance != null && input.embeddingDistance < 0.08) {
    return { gate: "originality", result: "block", reason: "Embedding distance to the source ad is too close. Offending beats must be regenerated." };
  }
  if (input.textSimilarity != null && input.textSimilarity >= 0.82) {
    return { gate: "originality", result: "block", reason: "Copy is too close to the source ad. Offending beats must be regenerated." };
  }
  return { gate: "originality", result: "pass", reason: "Stored similarity stays below the originality threshold." };
}

export function brandGate(input: {
  logoPresent: boolean | null;
  paletteMatch: number | null;
  productLooksRight: boolean | null;
}): GateVerdict {
  if (input.logoPresent == null || input.paletteMatch == null || input.productLooksRight == null) {
    return { gate: "brand", result: "review", reason: "Brand evidence is incomplete. A person must review." };
  }
  if (!input.logoPresent || !input.productLooksRight || input.paletteMatch < 0.5) {
    return { gate: "brand", result: "review", reason: "Logo, palette, or product match is weak. A person must review." };
  }
  return { gate: "brand", result: "pass", reason: "Logo, palette, and product match the brand kit evidence." };
}

export function claimsGate(input: {
  claims: string[];
  approvedClaims: string[];
  bannedWords: string[];
}): GateVerdict {
  const approved = new Set(input.approvedClaims.map((item) => item.trim().toLowerCase()).filter(Boolean));
  for (const claim of input.claims) {
    const key = claim.trim().toLowerCase();
    if (!key) continue;
    if (!approved.has(key)) {
      return { gate: "claims", result: "block", reason: `Claim "${claim.trim()}" is not on the approved list.` };
    }
  }
  const banned = input.bannedWords.map((item) => item.trim().toLowerCase()).filter(Boolean);
  const haystack = input.claims.join(" ").toLowerCase();
  for (const word of banned) {
    if (haystack.includes(word)) {
      return { gate: "claims", result: "block", reason: `Banned word "${word}" is present.` };
    }
  }
  return { gate: "claims", result: "pass", reason: "Every claim maps to an approved claim. No banned words." };
}

export function policyGate(input: {
  beforeAfter: boolean;
  personalAttribute: boolean;
  healthClaim: boolean;
  financeClaim: boolean;
}): GateVerdict {
  if (input.beforeAfter) return { gate: "policy", result: "block", reason: "Before/after imagery is blocked by the platform pre-check." };
  if (input.personalAttribute) return { gate: "policy", result: "block", reason: "Personal attributes are blocked by the platform pre-check." };
  if (input.healthClaim || input.financeClaim) {
    return { gate: "policy", result: "review", reason: "Health or finance language needs a person before launch." };
  }
  return { gate: "policy", result: "pass", reason: "No blocked policy flags were present." };
}

export function rightsGate(input: {
  musicLicensed: boolean;
  footageLicensed: boolean;
  aiLabeled: boolean;
}): GateVerdict {
  if (!input.musicLicensed || !input.footageLicensed) {
    return { gate: "rights", result: "block", reason: "Music or footage licence is missing." };
  }
  if (!input.aiLabeled) {
    return { gate: "rights", result: "block", reason: "AI-generated content is not labelled where the platform requires it." };
  }
  return { gate: "rights", result: "pass", reason: "Licences are recorded and AI labelling is present." };
}

export function combineGates(verdicts: GateVerdict[]): { result: "pass" | "block" | "review"; blocked: GateVerdict[]; review: GateVerdict[] } {
  const blocked = verdicts.filter((item) => item.result === "block");
  const review = verdicts.filter((item) => item.result === "review");
  if (blocked.length) return { result: "block", blocked, review };
  if (review.length) return { result: "review", blocked, review };
  return { result: "pass", blocked, review };
}
