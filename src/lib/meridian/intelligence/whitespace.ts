import { cosineSimilarity, type EmbeddingVector } from "../embeddings/provider.ts";
import type { CreativeFingerprint } from "./fingerprint.ts";

export type MarketCluster = {
  id: string;
  label: string;
  memberIds: string[];
  competitorCount: number;
  ownCount: number;
  summary: string;
};

export type WhitespaceFinding = {
  id: string;
  overused: string;
  overusedCount: number;
  underused: string;
  underusedCompetitorCount: number;
  ownCount: number;
  whoUsesIt: string[];
  brandHasUsedIt: boolean;
  alignsWithBrand: boolean;
  whyTest: string;
  confidence: number;
  evidenceIds: string[];
};

function normalize(values: number[]): number[] {
  const norm = Math.hypot(...values) || 1;
  return values.map((value) => value / norm);
}

/**
 * Test embedding. Axes are explicit so a test can cluster phrases.
 * This is not MiniLM and must stay labeled test:embedding.
 */
export function testLoopEmbedding(text: string): EmbeddingVector {
  const axes = ["lather", "proof", "demonstration", "offer", "discount", "save", "price", "cure"];
  const lower = text.toLowerCase();
  const values = normalize(axes.map((axis) => (lower.includes(axis) ? 1 : 0)));
  return {
    provider: "test:embedding",
    model: "test-axes-v1",
    kind: "test",
    dimensions: values.length,
    values,
  };
}

export function clusterFingerprints(
  items: { id: string; origin: string; angle: string; vector: EmbeddingVector }[],
  threshold = 0.72,
): MarketCluster[] {
  const clusters: { items: typeof items }[] = [];
  for (const item of items) {
    if (item.vector.kind === "lexical") throw new Error("Lexical hashes are not used for market clusters.");
    if (item.vector.kind !== "semantic" && item.vector.kind !== "test") {
      throw new Error("Market clusters need a semantic or explicit test embedding.");
    }
    let placed = false;
    for (const cluster of clusters) {
      const centroid = mean(cluster.items.map((member) => member.vector.values));
      if (cosineSimilarity(centroid, item.vector.values) >= threshold) {
        cluster.items.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ items: [item] });
  }
  return clusters.map((cluster, index) => {
    const angles = cluster.items.map((item) => item.angle).filter(Boolean);
    const label = mode(angles) || "unlabeled";
    const competitorCount = cluster.items.filter((item) => item.origin === "competitor").length;
    const ownCount = cluster.items.length - competitorCount;
    return {
      id: `cluster-${index + 1}`,
      label,
      memberIds: cluster.items.map((item) => item.id),
      competitorCount,
      ownCount,
      summary: `${cluster.items.length} creatives around ${label}. ${competitorCount} are competitors. ${ownCount} are this brand.`,
    };
  });
}

/**
 * Whitespace is a gap in stored observations. An empty set is not a gap.
 */
export function findWhitespace(input: {
  fingerprints: CreativeFingerprint[];
  origins: { id: string; origin: string }[];
  brandText: string;
}): WhitespaceFinding[] {
  const competitors = input.fingerprints.filter((item) => originOf(input.origins, item.creativeId) === "competitor");
  if (competitors.length === 0) return [];
  const counts = new Map<string, { competitorIds: string[]; own: number }>();
  for (const item of input.fingerprints) {
    const angle = item.angle.trim();
    if (angle.length < 2) continue;
    const bucket = counts.get(angle) ?? { competitorIds: [], own: 0 };
    if (originOf(input.origins, item.creativeId) === "competitor") bucket.competitorIds.push(item.creativeId);
    else bucket.own += 1;
    counts.set(angle, bucket);
  }
  let overused = "";
  let overusedCount = 0;
  for (const [angle, bucket] of counts) {
    if (bucket.competitorIds.length > overusedCount) {
      overused = angle;
      overusedCount = bucket.competitorIds.length;
    }
  }
  if (overusedCount < 3) return [];
  const brand = input.brandText.toLowerCase();
  const findings: WhitespaceFinding[] = [];
  for (const [angle, bucket] of counts) {
    if (angle === overused || bucket.own > 0 || bucket.competitorIds.length === 0) continue;
    const tokens = angle.split(/[^a-z0-9]+/).filter((token) => token.length >= 4);
    const aligns = tokens.some((token) => brand.includes(token));
    if (!aligns) continue;
    findings.push({
      id: `whitespace:${angle}`,
      overused,
      overusedCount,
      underused: angle,
      underusedCompetitorCount: bucket.competitorIds.length,
      ownCount: bucket.own,
      whoUsesIt: bucket.competitorIds,
      brandHasUsedIt: false,
      alignsWithBrand: true,
      whyTest: `${overused} appears on ${overusedCount} competitor creatives. ${angle} appears on ${bucket.competitorIds.length} and on none of this brand's creatives, and it matches the stored positioning.`,
      confidence: Math.min(0.85, bucket.competitorIds.length / 5),
      evidenceIds: bucket.competitorIds,
    });
  }
  return findings;
}

function originOf(origins: { id: string; origin: string }[], id: string): string {
  return origins.find((item) => item.id === id)?.origin ?? "";
}

function mode(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = "";
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function mean(vectors: number[][]): number[] {
  const dimensions = vectors[0]?.length ?? 0;
  const totals = new Array<number>(dimensions).fill(0);
  for (const vector of vectors) {
    for (let index = 0; index < dimensions; index += 1) totals[index] += vector[index] ?? 0;
  }
  const count = vectors.length || 1;
  return totals.map((value) => value / count);
}
