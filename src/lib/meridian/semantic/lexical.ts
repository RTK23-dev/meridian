import { attributeTokens, jaccard } from "../knowledge/model.ts";
import type { AttributeBag } from "../domain.ts";

/** Local token hashing. This is not a neural embedding and must not be described as one. */
export const LEXICAL_EMBEDDING = {
  id: "lexical-hash-v1",
  kind: "lexical" as const,
  dimensions: 64,
  status: "AVAILABLE" as const,
  note: "Hashed tokens from stored text. A neural embedding provider is not connected.",
};

export const NEURAL_EMBEDDING = {
  id: "neural",
  status: "NOT_CONNECTED" as const,
  note: "No embedding model is configured. Similarity below is lexical only.",
};

const DIM = LEXICAL_EMBEDDING.dimensions;

export function embedText(text: string): number[] {
  const vector = new Array<number>(DIM).fill(0);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
  if (tokens.length === 0) return vector;
  for (const token of tokens) {
    const hash = fnv(token);
    const index = Number(hash % BigInt(DIM));
    const sign = Number(hash % 2n) === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

export function cosine(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  for (let index = 0; index < length; index += 1) dot += (left[index] ?? 0) * (right[index] ?? 0);
  return Math.round(dot * 1000) / 1000;
}

export type CreativeRelation = "new" | "similar" | "derivative" | "duplicate" | "too_close_to_competitor";

export function classifyAgainst<T extends AttributeBag & { id: string; text: string; origin?: string }>(
  target: T,
  corpus: T[],
): { relation: CreativeRelation; neighborId: string | null; attributeSimilarity: number; textSimilarity: number } {
  let best: { item: T; attributeSimilarity: number; textSimilarity: number } | null = null;
  const targetTokens = attributeTokens(target);
  const targetVector = embedText(target.text);
  for (const item of corpus) {
    if (item.id === target.id) continue;
    const attributeSimilarity = jaccard(targetTokens, attributeTokens(item));
    const textSimilarity = cosine(targetVector, embedText(item.text));
    const score = Math.max(attributeSimilarity, textSimilarity);
    const bestScore = best ? Math.max(best.attributeSimilarity, best.textSimilarity) : -1;
    if (score > bestScore) best = { item, attributeSimilarity, textSimilarity };
  }
  if (!best) return { relation: "new", neighborId: null, attributeSimilarity: 0, textSimilarity: 0 };
  const close = best.attributeSimilarity >= 0.85 || best.textSimilarity >= 0.92;
  const relation: CreativeRelation = close
    ? best.item.origin === "competitor"
      ? "too_close_to_competitor"
      : "duplicate"
    : best.attributeSimilarity >= 0.6
      ? "derivative"
      : best.attributeSimilarity >= 0.34 || best.textSimilarity >= 0.5
        ? "similar"
        : "new";
  return {
    relation,
    neighborId: best.item.id,
    attributeSimilarity: round3(best.attributeSimilarity),
    textSimilarity: best.textSimilarity,
  };
}

export function clusterBy<T extends Record<string, string>>(items: T[], key: keyof T): { key: string; ids: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const value = String(item[key] ?? "").trim().toLowerCase();
    if (!value) continue;
    const id = String(item.id ?? "");
    const list = groups.get(value) ?? [];
    list.push(id);
    groups.set(value, list);
  }
  return [...groups.entries()].map(([group, ids]) => ({ key: group, ids }));
}

/** Angles present on competitor rows and absent from this brand's own rows. */
export function whitespaceAngles(
  creatives: { origin: string; angle: string }[],
): string[] {
  const competitor = new Set(
    creatives.filter((item) => item.origin === "competitor").map((item) => item.angle.trim().toLowerCase()).filter(Boolean),
  );
  const own = new Set(
    creatives.filter((item) => item.origin !== "competitor").map((item) => item.angle.trim().toLowerCase()),
  );
  return [...competitor].filter((angle) => !own.has(angle)).sort();
}

function fnv(value: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
