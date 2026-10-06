import type { MarketCluster, WhitespaceFinding } from "./whitespace.ts";

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4);
}

/** An underserved semantic cluster can be whitespace. Angle counts are not required. */
export function whitespaceFromClusters(input: {
  clusters: MarketCluster[];
  brandText: string;
}): WhitespaceFinding[] {
  const brand = tokens(input.brandText);
  const crowded = [...input.clusters].sort((a, b) => b.competitorCount - a.competitorCount)[0];
  if (!crowded || crowded.competitorCount < 1) return [];
  const findings: WhitespaceFinding[] = [];
  for (const cluster of input.clusters) {
    if (cluster.ownCount > 0 || cluster.competitorCount < 1) continue;
    if (cluster.label.trim().length < 2 || cluster.label === "unlabeled") continue;
    const labelTokens = tokens(cluster.label);
    const aligns = labelTokens.some((token) => brand.includes(token));
    if (!aligns) continue;
    findings.push({
      id: cluster.id,
      overused: crowded.label,
      overusedCount: crowded.competitorCount,
      underused: cluster.label,
      underusedCompetitorCount: cluster.competitorCount,
      ownCount: cluster.ownCount,
      whoUsesIt: cluster.memberIds,
      brandHasUsedIt: false,
      alignsWithBrand: true,
      whyTest: `Semantic cluster ${cluster.id} (${cluster.label}) holds ${cluster.competitorCount} competitor creative(s) and none from this brand. The densest stored cluster is ${crowded.label} (${crowded.competitorCount}).`,
      confidence: Math.min(0.85, cluster.competitorCount / 5),
      evidenceIds: cluster.memberIds,
    });
  }
  return findings;
}
