import { cosine, embedText } from "../semantic/lexical.ts";

export type Retrievable = {
  id: string;
  brandId: string;
  text: string;
};

/**
 * Top lexical matches for one brand. Other brands are dropped, not down-ranked.
 * A low score is omitted rather than padded with unrelated rows.
 */
export function selectContext(
  query: string,
  corpus: Retrievable[],
  brandId: string,
  limit = 4,
): { id: string; text: string; score: number }[] {
  const needle = embedText(query);
  return corpus
    .filter((item) => item.brandId === brandId && item.text.trim().length > 0)
    .map((item) => ({ id: item.id, text: item.text, score: cosine(needle, embedText(item.text)) }))
    .filter((item) => item.score >= 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
