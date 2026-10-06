import type { LearnedPattern, ObservedCreative } from "../domain.ts";
import { whitespaceFromClusters } from "../intelligence/semantic-gap.ts";
import type { MarketCluster } from "../intelligence/whitespace.ts";
import type { ResearchPattern } from "../research/patterns.ts";
import { HYPOTHESES } from "./catalog.ts";

/** A prior is a strategy the system knows how to brief. A discovered candidate came from stored evidence. */
export type StrategyCandidate = {
  id: string;
  source: "prior" | "discovered";
  label: string;
  angle: string;
  hookType: string;
  format: string;
  proofType: string;
  claimIntensity: number;
  keywords: string[];
  hookLine: string;
  clusterId?: string;
  clusterCompetitorCount?: number;
  clusterOwnCount?: number;
  clusterMemberIds?: string[];
  researchPattern?: ResearchPattern;
};

function token(value: string): string {
  return value.trim().toLowerCase();
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/**
 * Priors are exploration seeds.
 * Angles on stored competitor creatives, positive learned patterns, and underserved semantic clusters are discovered.
 */
export function strategyCandidates(
  creatives: ObservedCreative[],
  patterns: LearnedPattern[],
  semantic?: { clusters?: MarketCluster[]; brandText?: string; researchPatterns?: ResearchPattern[] },
): StrategyCandidate[] {
  const priors: StrategyCandidate[] = HYPOTHESES.map((item) => ({
    id: item.id,
    source: "prior",
    label: item.label,
    angle: item.angle,
    hookType: item.hookType,
    format: item.format,
    proofType: item.proofType,
    claimIntensity: item.claimIntensity,
    keywords: item.keywords,
    hookLine: item.hookLine,
  }));
  const known = new Set(priors.map((item) => item.angle));
  const seen = new Set<string>();
  const discovered: StrategyCandidate[] = [];

  for (const creative of creatives) {
    if (creative.origin !== "competitor") continue;
    const angle = token(creative.angle);
    if (angle.length < 2 || known.has(angle) || seen.has(angle)) continue;
    seen.add(angle);
    const hookType = token(creative.hookType) || "unspecified";
    const format = token(creative.format) || "unspecified";
    const proofType = token(creative.proofType) || "unspecified";
    discovered.push({
      id: `discovered:${angle}`,
      source: "discovered",
      label: `Observed angle: ${angle.replaceAll("_", " ")}`,
      angle,
      hookType,
      format,
      proofType,
      claimIntensity: 0.35,
      keywords: [angle, hookType, format, proofType, ...angle.split(/[^a-z0-9]+/)].filter(
        (item, index, all) => item.length >= 3 && item !== "unspecified" && all.indexOf(item) === index,
      ),
      hookLine: "Keep the observed structure. Do not copy the competitor's wording.",
    });
    if (discovered.length >= 8) break;
  }

  for (const pattern of patterns) {
    if (pattern.attribute !== "angle" || pattern.lift <= 0) continue;
    const angle = token(pattern.value);
    if (angle.length < 2 || known.has(angle) || seen.has(angle)) continue;
    seen.add(angle);
    discovered.push({
      id: `discovered:${angle}`,
      source: "discovered",
      label: `Learned angle: ${angle.replaceAll("_", " ")}`,
      angle,
      hookType: "unspecified",
      format: "unspecified",
      proofType: "unspecified",
      claimIntensity: 0.25,
      keywords: [angle],
      hookLine: "Repeat the structure that beat this brand's baseline. Do not invent a new claim.",
    });
    if (discovered.length >= 8) break;
  }

  const findings = whitespaceFromClusters({
    clusters: semantic?.clusters ?? [],
    brandText: semantic?.brandText ?? "",
  });
  for (const finding of findings) {
    const angle = slug(finding.underused);
    if (angle.length < 2 || known.has(angle) || seen.has(angle)) continue;
    seen.add(angle);
    discovered.push({
      id: `cluster:${finding.id}`,
      source: "discovered",
      label: `Semantic whitespace: ${finding.underused}`,
      angle,
      hookType: "unspecified",
      format: "unspecified",
      proofType: "unspecified",
      claimIntensity: 0.3,
      keywords: angle.split("_").filter((item) => item.length >= 3),
      hookLine: "Use the underserved semantic cluster. Do not copy competitor wording.",
      clusterId: finding.id,
      clusterCompetitorCount: finding.underusedCompetitorCount,
      clusterOwnCount: finding.ownCount,
      clusterMemberIds: finding.evidenceIds,
    });
    if (discovered.length >= 12) break;
  }

  for (const pattern of semantic?.researchPatterns ?? []) {
    if (pattern.dimension !== "creative_pattern" || pattern.sampleCount < 2 || pattern.confidence < 0.65) continue;
    let parts: { topic?: string; hook?: string; structure?: string; cta?: string };
    try { parts = JSON.parse(pattern.value) as typeof parts; } catch { continue; }
    const angle = token(parts.topic ?? "");
    const hookType = token(parts.hook ?? "");
    const format = "video";
    if (angle.length < 2 || !hookType || !parts.structure || !parts.cta) continue;
    const existing = [...discovered, ...priors].find((candidate) => token(candidate.angle) === angle);
    if (existing) {
      existing.researchPattern = pattern;
      existing.source = "discovered";
      existing.hookType = hookType;
      existing.format = format;
      existing.proofType = token(parts.structure);
      existing.keywords = [...new Set([...existing.keywords, angle, hookType, token(parts.structure), token(parts.cta)])];
      existing.hookLine = `Test the repeated ${hookType.replaceAll("_", " ")} opening and ${token(parts.structure).replaceAll("_", " ")} sequence with original wording and brand-supported claims.`;
      continue;
    }
    const id = `research:${slug(angle)}:${slug(hookType)}:${slug(parts.structure)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    discovered.push({
      id,
      source: "discovered",
      label: `External ad pattern: ${angle.replaceAll("_", " ")} · ${hookType.replaceAll("_", " ")}`,
      angle,
      hookType,
      format,
      proofType: token(parts.structure),
      claimIntensity: 0.25,
      keywords: [angle, hookType, token(parts.structure), token(parts.cta)].flatMap((item) => [item, ...item.split(/[^a-z0-9]+/)]).filter((item, index, all) => item.length >= 3 && all.indexOf(item) === index),
      hookLine: `Test the repeated ${hookType.replaceAll("_", " ")} opening and ${token(parts.structure).replaceAll("_", " ")} sequence with original wording and brand-supported claims.`,
      researchPattern: pattern,
      clusterMemberIds: pattern.exampleAdIds,
    });
    if (discovered.length >= 16) break;
  }

  return [...priors, ...discovered];
}
