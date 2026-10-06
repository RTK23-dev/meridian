import { cosineSimilarity, type EmbeddingVector } from "../embeddings/provider.ts";

export type ClusterMember = {
  id: string;
  origin: "competitor" | "own" | "generated" | "uploaded";
  angle: string;
  vector: EmbeddingVector;
};

export type CreativeCluster = {
  id: string;
  label: string;
  memberIds: string[];
  saturation: number;
  emerging: boolean;
  summary: string;
};

function mean(vectors: number[][]): number[] {
  const dimensions = vectors[0]?.length ?? 0;
  const totals = new Array<number>(dimensions).fill(0);
  for (const vector of vectors) {
    for (let index = 0; index < dimensions; index += 1) totals[index] += vector[index] ?? 0;
  }
  return totals.map((value) => value / vectors.length);
}

/** Greedy clusters. Labels come from stored angles, or stay unlabeled. */
export function clusterCreatives(members: ClusterMember[], threshold = 0.72): CreativeCluster[] {
  const clusters: { members: ClusterMember[] }[] = [];
  for (const member of members) {
    if (member.vector.kind === "lexical") throw new Error("Lexical hashes are not semantic embeddings.");
    let placed = false;
    for (const cluster of clusters) {
      const centroid = mean(cluster.members.map((item) => item.vector.values));
      if (cosineSimilarity(centroid, member.vector.values) >= threshold) {
        cluster.members.push(member);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ members: [member] });
  }
  return clusters.map((cluster, index) => {
    const angles = cluster.members.map((item) => item.angle.trim()).filter(Boolean);
    const label = mode(angles) || "unlabeled";
    const own = cluster.members.filter((item) => item.origin !== "competitor").length;
    const saturation = cluster.members.length === 0 ? 0 : own / cluster.members.length;
    return {
      id: `cluster-${index + 1}`,
      label,
      memberIds: cluster.members.map((item) => item.id),
      saturation,
      emerging: cluster.members.length <= 2,
      summary: `${cluster.members.length} creatives. ${own} belong to this brand. Label is ${label}.`,
    };
  });
}

export function clusterWhitespace(clusters: CreativeCluster[], members: ClusterMember[]): string[] {
  const ownAngles = new Set(members.filter((item) => item.origin !== "competitor").map((item) => item.angle.trim()).filter(Boolean));
  return [...new Set(clusters.map((cluster) => cluster.label).filter((label) => label !== "unlabeled" && !ownAngles.has(label)))];
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
