// Divergence (framework 12.1, steps C and D): the concept lab's seeds, the creative deck that forces combinations a model would not reach
// for, and the filters that keep only distinct, non-obvious, non-repeated ideas. Then the diversity-preserving choice of finalists (step
// E, after the tournament ranks them).
//
// Why: models converge on the same ideas, within one model and across models (the Artificial Hivemind result), and alignment rewards the
// familiar answer (typicality bias). The countermeasures here are mechanical, so they do not depend on a model noticing its own sameness.
// Similarity is word overlap, a heuristic: it says two ideas are worded alike, not that they do the same job. Pure and deterministic.

import { z } from "zod";
import { hookSimilarity, SIMILAR_HOOK_THRESHOLD } from "../content-factory/hook-history.ts";
import {
  EMOTION_IDS,
  FORMAT_IDS,
  HOOK_FAMILY_IDS,
  emotionIdSchema,
  formatIdSchema,
  hookFamilyIdSchema,
  nicheProfile,
  shareTriggerIdSchema,
  videoJobSchema,
  type EmotionId,
  type FormatId,
  type HookFamilyId,
  type NicheFamily,
} from "./codex.ts";
import { seededRandom } from "./random.ts";

/**
 * One concept seed, as the concept lab returns it (concept_lab@2). `probability` is the lab's own estimate of how typical the idea is
 * (verbalized sampling). The idea is the cake (Kallaway): a topic, a non-obvious core argument with the brief's evidence for it (the
 * lawyer method), the job, and how broad an audience it aims at (the virality stack).
 */
export const conceptSeedSchema = z.strictObject({
  topic: z.string().min(1).max(80),
  coreArgument: z.string().min(1).max(240),
  evidence: z.string().min(1).max(240),
  job: videoJobSchema,
  audience: z.enum(["broad", "narrow"]),
  hookFamily: hookFamilyIdSchema,
  format: formatIdSchema,
  feeling: emotionIdSchema,
  angle: z.string().min(1).max(240),
  hook: z.strictObject({
    picture: z.string().min(1).max(240),
    text: z.string().max(80),
    voice: z.string().max(240),
  }),
  promise: z.string().min(1).max(200),
  payoff: z.string().min(1).max(300),
  sendTrigger: shareTriggerIdSchema,
  novelty: z.string().min(1).max(240),
  probability: z.number().min(0).max(1),
});
export type ConceptSeed = z.infer<typeof conceptSeedSchema>;

/** The concept lab's answer: the obvious ideas it bans first, then its concepts. */
export const conceptLabAnswerSchema = z.strictObject({
  obvious: z.array(z.string().min(1).max(240)).min(3).max(12),
  concepts: z.array(conceptSeedSchema).min(1).max(12),
});
export type ConceptLabAnswer = z.infer<typeof conceptLabAnswerSchema>;

/** A concept in the pool: a seed with its id and where it came from. */
export type Concept = ConceptSeed & { id: string; source: { family: string; call: number } };

/** One card of the creative deck: a combination the lab is asked to build a concept on. */
export type DeckCard = { hookFamily: HookFamilyId; format: FormatId; feeling: EmotionId };

/**
 * A deck of `count` cards. Hook families and feelings that fit the niche are drawn twice as often as the rest, so the deck leans to the
 * niche without excluding the tails. No combination of family and format repeats, and no family appears more than twice.
 */
export function creativeDeck(options: { count: number; seed: string; niche?: NicheFamily }): DeckCard[] {
  const random = seededRandom(`deck:${options.seed}`);
  const profile = options.niche ? nicheProfile(options.niche) : null;
  const weighted = <T extends string>(ids: readonly T[], favoured: readonly T[]): T[] => ids.flatMap((id) => (favoured.includes(id) ? [id, id] : [id]));
  const families = weighted(HOOK_FAMILY_IDS, profile?.hookFamilies ?? []);
  const feelings = weighted(EMOTION_IDS.filter((id) => id !== "sadness"), profile?.emotions ?? []);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;

  const cards: DeckCard[] = [];
  const used = new Set<string>();
  const perFamily = new Map<HookFamilyId, number>();
  let attempts = 0;
  while (cards.length < options.count && attempts < options.count * 50) {
    attempts += 1;
    const hookFamily = pick(families);
    const format = pick(FORMAT_IDS);
    const key = `${hookFamily}:${format}`;
    if (used.has(key) || (perFamily.get(hookFamily) ?? 0) >= 2) continue;
    used.add(key);
    perFamily.set(hookFamily, (perFamily.get(hookFamily) ?? 0) + 1);
    cards.push({ hookFamily, format, feeling: pick(feelings) });
  }
  return cards;
}

const STOPWORDS = new Set(
  "a an and are as at be but by for from has have i in is it its of on or so that the their them they this to was we what when which who will with you your".split(" "),
);

/** A text's content words: lower case, letters and digits of any script, stop words and one-letter words dropped. */
export function contentWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter((word) => word.length > 1 && !STOPWORDS.has(word)));
}

/** Word overlap of two texts, from 0 to 1 (Jaccard on content words). */
export function textSimilarity(a: string, b: string): number {
  const left = contentWords(a);
  const right = contentWords(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** The words of a concept that say what it is: its angle, its hook and its promise. */
export function conceptText(concept: ConceptSeed): string {
  return [concept.angle, concept.coreArgument, concept.hook.voice, concept.hook.text, concept.promise].join(" ");
}

/** How alike two concepts are, from 0 to 1: their wording, and whether they share a hook family, a format and a feeling. */
export function conceptSimilarity(a: ConceptSeed, b: ConceptSeed): number {
  const structure = ((a.hookFamily === b.hookFamily ? 1 : 0) + (a.format === b.format ? 1 : 0) + (a.feeling === b.feeling ? 1 : 0)) / 3;
  return 0.6 * textSimilarity(conceptText(a), conceptText(b)) + 0.4 * structure;
}

/** Number the concept lab's answers into one pool, in call order. */
export function poolConcepts(answers: readonly { family: string; call: number; answer: ConceptLabAnswer }[]): { concepts: Concept[]; obvious: string[] } {
  const concepts: Concept[] = [];
  const obvious: string[] = [];
  for (const { family, call, answer } of answers) {
    obvious.push(...answer.obvious);
    for (const seed of answer.concepts) concepts.push({ ...seed, id: `c${concepts.length + 1}`, source: { family, call } });
  }
  return { concepts, obvious };
}

export type ConceptDrop = { id: string; reason: "duplicate" | "obvious" | "repeats_history"; similarity: number; of: string };

export type FilterThresholds = { duplicateAt: number; obviousAt: number; historyAt: number };

/** Initial thresholds (hypothesis). Word overlap at these levels reads as the same idea reworded. */
export const FILTER_THRESHOLDS: FilterThresholds = { duplicateAt: 0.5, obviousAt: 0.45, historyAt: SIMILAR_HOOK_THRESHOLD };

/**
 * Keep the concepts that are not near-copies of each other, of the obvious ideas the lab banned, or of the brand's recent hooks. Earlier
 * concepts win a duplicate; every drop records why and what it resembled.
 */
export function filterConcepts(
  concepts: readonly Concept[],
  context: { obvious: readonly string[]; recentHooks: readonly string[] },
  thresholds: FilterThresholds = FILTER_THRESHOLDS,
): { kept: Concept[]; dropped: ConceptDrop[] } {
  const kept: Concept[] = [];
  const dropped: ConceptDrop[] = [];
  for (const concept of concepts) {
    const text = conceptText(concept);
    const obvious = closest(context.obvious, (idea) => textSimilarity(text, idea));
    if (obvious && obvious.similarity >= thresholds.obviousAt) {
      dropped.push({ id: concept.id, reason: "obvious", similarity: obvious.similarity, of: obvious.item });
      continue;
    }
    const history = closest(context.recentHooks, (hook) => hookSimilarity(concept.hook.voice || concept.hook.text, hook));
    if (history && history.similarity >= thresholds.historyAt) {
      dropped.push({ id: concept.id, reason: "repeats_history", similarity: history.similarity, of: history.item });
      continue;
    }
    const duplicate = closest(kept, (other) => textSimilarity(text, conceptText(other)));
    if (duplicate && duplicate.similarity >= thresholds.duplicateAt) {
      dropped.push({ id: concept.id, reason: "duplicate", similarity: duplicate.similarity, of: duplicate.item.id });
      continue;
    }
    kept.push(concept);
  }
  return { kept, dropped };
}

function closest<T>(items: readonly T[], score: (item: T) => number): { item: T; similarity: number } | null {
  let best: { item: T; similarity: number } | null = null;
  for (const item of items) {
    const similarity = score(item);
    if (!best || similarity > best.similarity) best = { item, similarity };
  }
  return best;
}

/**
 * The finalists: the best-rated concepts, kept apart (maximal marginal relevance). Each pick maximises
 * `lambda * relevance - (1 - lambda) * similarity to the picks so far`. Relevance is a concept's expected score against the top-rated
 * concept on the Elo scale (0.5 for the top itself), so a small rating gap stays a small difference and a near-copy cannot crowd out a
 * different idea that rates almost as well.
 */
export function selectDiverse(ranked: readonly { concept: Concept; rating: number }[], count: number, lambda = 0.7): Concept[] {
  if (ranked.length === 0 || count <= 0) return [];
  const top = Math.max(...ranked.map((entry) => entry.rating));
  const remaining = [...ranked];
  const picked: Concept[] = [];
  while (picked.length < count && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    remaining.forEach((entry, index) => {
      const relevance = 1 / (1 + 10 ** ((top - entry.rating) / 400));
      const redundancy = picked.length === 0 ? 0 : Math.max(...picked.map((other) => conceptSimilarity(entry.concept, other)));
      const score = lambda * relevance - (1 - lambda) * redundancy;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    picked.push(remaining.splice(bestIndex, 1)[0]!.concept);
  }
  return picked;
}

/** The deck cards for one concept-lab call: a slice of the deck, so each call builds on different combinations. */
export function cardsForCall(deck: readonly DeckCard[], call: number, perCall: number): DeckCard[] {
  if (deck.length === 0) return [];
  const start = (call * perCall) % deck.length;
  return Array.from({ length: Math.min(perCall, deck.length) }, (_, index) => deck[(start + index) % deck.length]!);
}
