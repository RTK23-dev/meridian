import type { AttributeBag } from "../domain.ts";

const KEYS = ["angle", "hookType", "format", "proofType", "offer", "visualStyle", "platform", "emotion", "cta"] as const;

export type AttributeQuery = Partial<Record<(typeof KEYS)[number], string>>;

export function attributeTokens(item: AttributeBag): string[] {
  const tokens: string[] = [];
  for (const key of KEYS) {
    const value = item[key].trim().toLowerCase();
    if (value) tokens.push(`${key}:${value}`);
  }
  return tokens;
}

export function jaccard(left: string[], right: string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function queryCreatives<T extends AttributeBag>(items: T[], query: AttributeQuery): T[] {
  return items.filter((item) =>
    KEYS.every((key) => {
      const expected = query[key]?.trim().toLowerCase();
      if (!expected) return true;
      return item[key].trim().toLowerCase() === expected;
    }),
  );
}

/** Similar on attributes, but not a near-duplicate. */
export function findSimilar<T extends AttributeBag>(
  target: T,
  corpus: T[],
  bounds: { min: number; max: number } = { min: 0.34, max: 0.8 },
): { item: T; similarity: number }[] {
  const targetTokens = attributeTokens(target);
  return corpus
    .map((item) => ({ item, similarity: jaccard(targetTokens, attributeTokens(item)) }))
    .filter((row) => row.similarity >= bounds.min && row.similarity <= bounds.max)
    .sort((a, b) => b.similarity - a.similarity);
}
