import type { BrainSlice, ObservedCreative } from "../domain.ts";

export type CreativeFingerprint = {
  creativeId: string;
  angle: string;
  hook: string;
  hookType: string;
  audience: string;
  problem: string;
  promise: string;
  product: string;
  offer: string;
  cta: string;
  proofType: string;
  visualStyle: string;
  composition: string;
  format: string;
  platform: string;
  creatorStyle: string;
  copyStructure: string;
  openingPattern: string;
  demonstrationPattern: string;
  socialProofPattern: string;
  claimIntensity: number;
  brandSignals: string[];
};

function line(value: string): string {
  return value.trim().toLowerCase();
}

/** Structured read of a stored creative. This is not an embedding. */
export function fingerprintCreative(creative: ObservedCreative, brain?: BrainSlice): CreativeFingerprint {
  const text = creative.text.trim();
  const hook = text.split(/[.\n]/)[0]?.trim() ?? "";
  const sentences = text.split(/[.!?]+/).map((part) => part.trim()).filter(Boolean);
  const brandSignals = brain
    ? [brain.positioning, brain.valueProposition, brain.tone]
        .join(" ")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 5 && text.toLowerCase().includes(token))
        .slice(0, 8)
    : [];
  const claimIntensity = /cure|guarantee|miracle|100%/.test(text.toLowerCase()) ? 0.9 : creative.claim.trim() ? 0.45 : 0.15;
  return {
    creativeId: creative.id,
    angle: line(creative.angle),
    hook,
    hookType: line(creative.hookType) || "unspecified",
    audience: brain?.targetCustomers.trim() ?? "",
    problem: /problem|hard|stuck|before/.test(text.toLowerCase()) ? "problem_open" : "",
    promise: brain?.valueProposition.trim() ?? "",
    product: creative.productName.trim(),
    offer: line(creative.offer),
    cta: line(creative.cta),
    proofType: line(creative.proofType) || "unspecified",
    visualStyle: line(creative.visualStyle) || "unspecified",
    composition: creative.format.includes("ugc") ? "creator_held" : "single_subject",
    format: line(creative.format) || "unspecified",
    platform: line(creative.platform) || "unspecified",
    creatorStyle: creative.origin === "competitor" ? "competitor_ad" : "brand",
    copyStructure: sentences.length > 2 ? "multi_beat" : "single_beat",
    openingPattern: line(creative.hookType) || "statement",
    demonstrationPattern: /demo|lather|show|proof/.test(`${creative.proofType} ${text}`.toLowerCase()) ? "shows_use" : "",
    socialProofPattern: /review|customer|testimonial/.test(`${creative.proofType} ${text}`.toLowerCase()) ? "quote" : "",
    claimIntensity,
    brandSignals,
  };
}
