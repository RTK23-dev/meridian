import { clamp01 } from "../domain.ts";
import type { LearnedPattern } from "../domain.ts";
import { HYPOTHESES } from "./catalog.ts";

export type EvidenceCandidate = {
  id: string;
  source: "discovered" | "exploration";
  label: string;
  angle: string;
  hookType: string;
  format: string;
  proofType: string;
  reason: string;
  evidenceIds: string[];
  alignment: number;
};

export type PosteriorRank = EvidenceCandidate & {
  score: number;
  draw: number;
  shrunkLift: number;
  trials: number;
};

function hashUnit(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

/** Deterministic draw from a Beta(1+successes, 1+failures) spread. Not a hand-set score. */
export function posteriorDraw(input: { successes: number; trials: number; seed: string }): number {
  const successes = Math.max(0, input.successes);
  const failures = Math.max(0, input.trials - successes);
  const alpha = 1 + successes;
  const beta = 1 + failures;
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  const z = hashUnit(input.seed) * 2 - 1;
  return clamp01(mean + z * Math.sqrt(variance));
}

export function rankFromEvidence(input: {
  discovered: EvidenceCandidate[];
  patterns: LearnedPattern[];
  performance: { angle: string; clicks: number; impressions: number }[];
  seed: string;
}): PosteriorRank[] {
  const exploration: EvidenceCandidate[] = HYPOTHESES.map((item) => ({
    id: `exploration:${item.id}`,
    source: "exploration" as const,
    label: `Exploration: ${item.label}`,
    angle: item.angle,
    hookType: item.hookType,
    format: item.format,
    proofType: item.proofType,
    reason: "This is a strategy seed, not a market finding. It is held back unless evidence supports it.",
    evidenceIds: [],
    alignment: 0.15,
  }));
  const seen = new Set(input.discovered.map((item) => item.angle));
  const candidates = [...input.discovered, ...exploration.filter((item) => !seen.has(item.angle))];
  const ranked = candidates.map((candidate) => {
    const rows = input.performance.filter((row) => row.angle === candidate.angle);
    const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
    const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
    const draw = posteriorDraw({ successes: clicks, trials: Math.max(impressions, rows.length), seed: `${input.seed}:${candidate.angle}` });
    const related = input.patterns.filter((pattern) => pattern.value.split("+")[0] === candidate.angle || pattern.value === candidate.angle);
    const lift = related.reduce((sum, pattern) => sum + pattern.lift * (pattern.sampleSize / (pattern.sampleSize + 8)), 0);
    const score = clamp01(candidate.alignment * 0.55 + (candidate.source === "discovered" ? 0.25 : 0) + draw * 0.2 + lift * 0.35);
    return { ...candidate, score, draw, shrunkLift: lift, trials: rows.length };
  });
  ranked.sort((a, b) => b.score - a.score || a.angle.localeCompare(b.angle));
  const explore = ranked.find((item) => item.source === "exploration" && item.trials < 3);
  if (explore && ranked[0]?.source !== "exploration") {
    const without = ranked.filter((item) => item.id !== explore.id);
    without.splice(Math.min(3, without.length), 0, explore);
    return without;
  }
  return ranked;
}
