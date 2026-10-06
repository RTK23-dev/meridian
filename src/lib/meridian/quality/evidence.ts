const DAY = 24 * 60 * 60 * 1000;

export type EvidenceQuality = {
  freshness: "fresh" | "aging" | "stale";
  duplicate: boolean;
  weak: boolean;
};

/** Weak, stale, or duplicate evidence is labeled. It is not rewritten into a stronger fact. */
export function assessEvidence(input: { text: string; collectedAt: number; now: number; duplicate: boolean }): EvidenceQuality {
  const age = input.now - input.collectedAt;
  const freshness = age > 90 * DAY ? "stale" : age > 30 * DAY ? "aging" : "fresh";
  const thin = input.text.trim().length < 40;
  return {
    freshness,
    duplicate: input.duplicate,
    weak: thin || input.duplicate || freshness === "stale",
  };
}
