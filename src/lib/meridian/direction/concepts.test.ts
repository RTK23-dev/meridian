import assert from "node:assert/strict";
import test from "node:test";
import { nicheProfile } from "./codex.ts";
import {
  cardsForCall,
  conceptLabAnswerSchema,
  conceptSimilarity,
  creativeDeck,
  filterConcepts,
  poolConcepts,
  selectDiverse,
  textSimilarity,
  type Concept,
  type ConceptSeed,
} from "./concepts.ts";
import { seededRandom, shuffled } from "./random.ts";

const seed = (overrides: Partial<ConceptSeed> = {}): ConceptSeed => ({
  hookFamily: "challenge_test",
  format: "test_experiment",
  feeling: "surprise",
  angle: "Three mugs, one kettle, two hours: which keeps coffee hot",
  hook: { picture: "Three mugs filled at once", text: "Only 1 stays hot", voice: "Three mugs. Same coffee. Two hours." },
  promise: "Which mug keeps coffee hot",
  payoff: "The double-wall mug wins, and the steel one fails because of its lid",
  sendTrigger: "utility",
  novelty: "The popular steel mug loses",
  probability: 0.08,
  ...overrides,
});

const concept = (id: string, overrides: Partial<ConceptSeed> = {}): Concept => ({ ...seed(overrides), id, source: { family: "a", call: 0 } });

test("seeded randomness replays: the same seed gives the same sequence and the same order", () => {
  const one = seededRandom("run-1");
  const two = seededRandom("run-1");
  assert.deepEqual([one(), one(), one()], [two(), two(), two()]);
  assert.notDeepEqual([seededRandom("run-1")()], [seededRandom("run-2")()]);
  assert.deepEqual(shuffled([1, 2, 3, 4, 5], "x"), shuffled([1, 2, 3, 4, 5], "x"));
  assert.deepEqual([...shuffled([1, 2, 3, 4, 5], "x")].sort(), [1, 2, 3, 4, 5]);
});

test("the creative deck is reproducible, never repeats a combination, and uses a family at most twice", () => {
  const deck = creativeDeck({ count: 18, seed: "brief-7", niche: "food" });
  assert.deepEqual(deck, creativeDeck({ count: 18, seed: "brief-7", niche: "food" }));
  assert.equal(deck.length, 18);
  assert.equal(new Set(deck.map((card) => `${card.hookFamily}:${card.format}`)).size, 18);
  const perFamily = new Map<string, number>();
  for (const card of deck) perFamily.set(card.hookFamily, (perFamily.get(card.hookFamily) ?? 0) + 1);
  assert.ok([...perFamily.values()].every((count) => count <= 2));
  assert.ok(deck.every((card) => card.feeling !== "sadness"), "sadness alone does not spread, so the deck never deals it");
  const favoured = deck.filter((card) => nicheProfile("food").hookFamilies.includes(card.hookFamily)).length;
  assert.ok(favoured >= 1, "the niche's families are in the deck");
  assert.ok(favoured < deck.length, "and the tails are too");
});

test("each concept-lab call builds on its own slice of the deck", () => {
  const deck = creativeDeck({ count: 12, seed: "s" });
  assert.deepEqual(cardsForCall(deck, 0, 4), deck.slice(0, 4));
  assert.deepEqual(cardsForCall(deck, 1, 4), deck.slice(4, 8));
  assert.deepEqual(cardsForCall(deck, 3, 4), deck.slice(0, 4), "the slices wrap around");
  assert.deepEqual(cardsForCall([], 0, 4), []);
});

test("the lab's answer contract asks for the obvious ideas first, and refuses an unknown family", () => {
  assert.equal(conceptLabAnswerSchema.safeParse({ obvious: ["a", "b", "c"], concepts: [seed()] }).success, true);
  assert.equal(conceptLabAnswerSchema.safeParse({ obvious: ["a"], concepts: [seed()] }).success, false, "at least three obvious ideas");
  assert.equal(conceptLabAnswerSchema.safeParse({ obvious: ["a", "b", "c"], concepts: [{ ...seed(), hookFamily: "clickbait" }] }).success, false);
  assert.equal(conceptLabAnswerSchema.safeParse({ obvious: ["a", "b", "c"], concepts: [{ ...seed(), extra: 1 }] }).success, false, "no unknown keys");
});

test("the pool numbers concepts across calls and keeps where each came from", () => {
  const { concepts, obvious } = poolConcepts([
    { family: "claude", call: 0, answer: { obvious: ["x", "y", "z"], concepts: [seed(), seed()] } },
    { family: "other", call: 1, answer: { obvious: ["w", "v", "u"], concepts: [seed()] } },
  ]);
  assert.deepEqual(concepts.map((entry) => [entry.id, entry.source.family]), [["c1", "claude"], ["c2", "claude"], ["c3", "other"]]);
  assert.deepEqual(obvious, ["x", "y", "z", "w", "v", "u"]);
});

test("filters drop the obvious idea, the brand's repeated hook and a reworded duplicate, and say why", () => {
  const pool = [
    concept("c1"),
    concept("c2", { angle: "Which mug keeps coffee hot longest", hook: { picture: "p", text: "", voice: "Which mug keeps coffee hot longest?" }, promise: "Which mug keeps coffee hot longest" }),
    concept("c3", { angle: "My grandmother's thermos beat every new mug", hook: { picture: "p", text: "", voice: "Same coffee, two hours, three mugs." }, promise: "An old thermos wins" }),
    concept("c4", { angle: "Three mugs, one kettle, two hours: which keeps coffee hottest", promise: "Which mug keeps the coffee hot" }),
    concept("c5", { hookFamily: "confession", angle: "I returned 40 mugs before finding one that works", hook: { picture: "A pile of returned mug boxes", text: "40 returns", voice: "I sent back forty mugs." }, promise: "The one I kept" }),
  ];
  const { kept, dropped } = filterConcepts(pool, {
    obvious: ["Which mug keeps coffee hot longest"],
    recentHooks: ["Three mugs, same coffee, two hours"],
  });
  assert.deepEqual(
    dropped.map((drop) => [drop.id, drop.reason]),
    [
      ["c1", "repeats_history"],
      ["c2", "obvious"],
      ["c3", "repeats_history"],
      ["c4", "repeats_history"],
    ],
  );
  assert.deepEqual(kept.map((entry) => entry.id), ["c5"]);

  const fresh = filterConcepts(pool.slice(3).concat(concept("c6", { angle: "Three mugs, one kettle, two hours: which keeps coffee hottest of all" })), { obvious: [], recentHooks: [] });
  assert.deepEqual(fresh.dropped.map((drop) => [drop.id, drop.reason, drop.of]), [["c6", "duplicate", "c4"]]);
});

test("similarity reads words in any script, and structure adds to it", () => {
  assert.equal(textSimilarity("", "anything"), 0);
  assert.ok(textSimilarity("Kaffee bleibt heiß", "Der Kaffee bleibt zwei Stunden heiß") > 0.4);
  const a = seed();
  assert.ok(conceptSimilarity(a, seed()) > conceptSimilarity(a, seed({ hookFamily: "confession", format: "story", feeling: "relief" })));
});

test("finalists are the best-rated concepts kept apart: a near-copy of the leader gives way to a different idea", () => {
  const leader = concept("c1");
  const copy = concept("c2", { angle: "Three mugs, one kettle, two hours: which keeps the coffee hot" });
  const different = concept("c3", { hookFamily: "confession", format: "story", feeling: "relief", angle: "I sent back forty mugs", hook: { picture: "boxes", text: "40 returns", voice: "I sent back forty mugs." }, promise: "The one I kept" });
  const picks = selectDiverse(
    [
      { concept: leader, rating: 1700 },
      { concept: copy, rating: 1690 },
      { concept: different, rating: 1600 },
    ],
    2,
  );
  assert.deepEqual(picks.map((entry) => entry.id), ["c1", "c3"]);
  assert.deepEqual(selectDiverse([], 3), []);
});
