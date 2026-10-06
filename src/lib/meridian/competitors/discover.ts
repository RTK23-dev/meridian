export type CompetitorStatus = "CANDIDATE" | "CONFIRMED" | "REJECTED";

export type CompetitorCandidate = {
  name: string;
  relationship: "direct" | "adjacent" | "positioning";
  confidence: number;
  evidence: string[];
  source: string;
  status: "CANDIDATE";
};

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4),
  );
}

function overlap(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.max(left.size, right.size);
}

/**
 * Candidates only. A weak overlap is not a confirmed competitor.
 * Confirmation is a separate user action.
 */
export function discoverCompetitorCandidates(input: {
  brandName: string;
  category: string;
  positioning: string;
  confirmedNames: string[];
  advertisers: { name: string; evidence: string }[];
  similarBrands?: { name: string; positioning: string }[];
}): CompetitorCandidate[] {
  const own = input.brandName.trim().toLowerCase();
  const confirmed = new Set(input.confirmedNames.map((name) => name.trim().toLowerCase()));
  const brandTokens = tokens(`${input.category} ${input.positioning}`);
  const found = new Map<string, CompetitorCandidate>();
  const add = (name: string, relationship: CompetitorCandidate["relationship"], confidence: number, evidence: string, source: string) => {
    const key = name.trim().toLowerCase();
    if (!key || key === own || confirmed.has(key)) return;
    const current = found.get(key);
    if (!current) {
      found.set(key, { name: name.trim(), relationship, confidence, evidence: [evidence], source, status: "CANDIDATE" });
      return;
    }
    current.confidence = Math.max(current.confidence, confidence);
    current.evidence.push(evidence);
    if (relationship === "direct") current.relationship = "direct";
  };
  for (const advertiser of input.advertisers) {
    const name = advertiser.name.trim();
    if (!name) continue;
    add(name, "direct", 0.62, advertiser.evidence || "Named in stored market evidence.", "market");
  }
  for (const brand of input.similarBrands ?? []) {
    const score = overlap(brandTokens, tokens(brand.positioning));
    if (score < 0.34) continue;
    add(brand.name, "positioning", Math.min(0.58, 0.3 + score / 2), `Positioning overlap ${score.toFixed(2)}. Not confirmed.`, "positioning");
  }
  return [...found.values()].sort((a, b) => b.confidence - a.confidence);
}

export function reviewCompetitorCandidate<T extends { status: CompetitorStatus | "CANDIDATE" }>(
  candidate: T,
  action: "confirm" | "reject",
): Omit<T, "status"> & { status: "CONFIRMED" | "REJECTED" } {
  if (action === "confirm") return { ...candidate, status: "CONFIRMED" };
  return { ...candidate, status: "REJECTED" };
}
