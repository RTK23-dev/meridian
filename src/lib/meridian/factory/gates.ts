import { PNG } from "pngjs";
import { cosineSimilarity } from "../embeddings/provider.ts";

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

function computePerceptualHash(pngBytes: Uint8Array): bigint | null {
  let png: PNG;
  try {
    png = PNG.sync.read(Buffer.from(pngBytes));
  } catch {
    return null;
  }
  if (png.width < 2 || png.height < 2) return null;
  const cells = 8;
  const values: number[] = [];
  for (let y = 0; y < cells; y += 1) {
    for (let x = 0; x < cells; x += 1) {
      const sx = Math.min(png.width - 1, Math.floor((x + 0.5) * (png.width / cells)));
      const sy = Math.min(png.height - 1, Math.floor((y + 0.5) * (png.height / cells)));
      const index = (png.width * sy + sx) * 4;
      const red = png.data[index] ?? 0;
      const green = png.data[index + 1] ?? 0;
      const blue = png.data[index + 2] ?? 0;
      values.push(red * 0.3 + green * 0.59 + blue * 0.11);
    }
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let hash = 0n;
  values.forEach((value, index) => {
    if (value >= mean) hash |= 1n << BigInt(index);
  });
  return hash;
}

function hammingDistance(left: bigint, right: bigint): number {
  let bits = left ^ right;
  let count = 0;
  while (bits) {
    count += Number(bits & 1n);
    bits >>= 1n;
  }
  return count;
}

function computeTokenSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection += 1;
  }
  return intersection / Math.max(wordsA.size, wordsB.size);
}

/**
 * Compares perceptual hashes and embeddings of frames against the source ad.
 * Gate failures block; missing evidence routes to review.
 */
export function compareOriginalityAgainstSource(input: {
  variantFrames?: Uint8Array[];
  sourceFrames?: Uint8Array[];
  variantEmbedding?: number[] | null;
  sourceEmbedding?: number[] | null;
  variantText?: string;
  sourceText?: string;
}): GateVerdict {
  let minFrameDistance: number | null = null;
  if (input.variantFrames?.length && input.sourceFrames?.length) {
    const vHashes = input.variantFrames.map(computePerceptualHash).filter((h): h is bigint => h !== null);
    const sHashes = input.sourceFrames.map(computePerceptualHash).filter((h): h is bigint => h !== null);
    if (vHashes.length > 0 && sHashes.length > 0) {
      let min = 64;
      for (const v of vHashes) {
        for (const s of sHashes) {
          const dist = hammingDistance(v, s);
          if (dist < min) min = dist;
        }
      }
      minFrameDistance = min;
    }
  }

  let embeddingDistance: number | null = null;
  if (input.variantEmbedding?.length && input.sourceEmbedding?.length) {
    const sim = cosineSimilarity(input.variantEmbedding, input.sourceEmbedding);
    embeddingDistance = Math.max(0, 1 - sim);
  }

  let textSimilarity: number | null = null;
  if (input.variantText && input.sourceText) {
    textSimilarity = computeTokenSimilarity(input.variantText, input.sourceText);
  }

  return originalityGate({
    frameHashDistance: minFrameDistance,
    embeddingDistance,
    textSimilarity,
  });
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

/**
 * Checks the claim text a variant makes against the brand's approved claims and banned words. The claim text is the input
 * the check exists for. When none is recorded (`null`, or an empty list), nothing was checked, so the result is review and
 * never pass. Missing evidence is review, not a pass.
 */
export function claimsGate(input: {
  claims: string[] | null;
  approvedClaims: string[];
  bannedWords: string[];
}): GateVerdict {
  const claims = (input.claims ?? []).filter((claim) => claim.trim().length > 0);
  if (claims.length === 0) {
    return { gate: "claims", result: "review", reason: "No claim text is recorded for this variant. A person must check its claims." };
  }
  const approved = new Set(input.approvedClaims.map((item) => item.trim().toLowerCase()).filter(Boolean));
  for (const claim of claims) {
    const key = claim.trim().toLowerCase();
    if (!approved.has(key)) {
      return { gate: "claims", result: "block", reason: `Claim "${claim.trim()}" is not on the approved list.` };
    }
  }
  const banned = input.bannedWords.map((item) => item.trim().toLowerCase()).filter(Boolean);
  const haystack = claims.join(" ").toLowerCase();
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
  return { result: "pass", blocked: [], review: [] };
}
