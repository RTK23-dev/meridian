// Convergence (framework 3.3 and 12.1, step E): pairwise judging with the order swapped, and a ranking from the results. LLM judges
// favour the first or second option shown, longer text and their own family's text, and pick creative winners at little better than
// chance from text alone (the LOLA result). So a judge never scores in the absolute here: it chooses between two, every pair is shown in
// both orders, and a choice that flips with the order counts as a tie. The ranking is Bradley-Terry, fitted by the MM algorithm, with a
// weak prior so that an item with no wins still has a finite strength. The reliability numbers say how far the ranking can be trusted.
//
// Pure and deterministic.

import { z } from "zod";
import { shuffled } from "./random.ts";

export type Pair = { a: string; b: string };

/**
 * Pairs so that each id meets about `opponents * 2` others: ids in a seeded order, each paired with the ids `1..opponents` places after it
 * (wrapping around). With few ids every pair is played once.
 */
export function pairSchedule(ids: readonly string[], opponents: number, seed: string): Pair[] {
  const order = shuffled([...new Set(ids)], `pairs:${seed}`);
  const count = order.length;
  if (count < 2) return [];
  const pairs: Pair[] = [];
  const seen = new Set<string>();
  const reach = Math.min(opponents, Math.floor(count / 2));
  for (let offset = 1; offset <= Math.max(1, reach); offset += 1) {
    for (let index = 0; index < count; index += 1) {
      const a = order[index]!;
      const b = order[(index + offset) % count]!;
      const key = [a, b].sort().join("|");
      if (a === b || seen.has(key)) continue;
      seen.add(key);
      pairs.push({ a, b });
    }
  }
  return pairs;
}

export const VERDICTS = ["first", "second", "tie"] as const;
export const verdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof verdictSchema>;

/** One judged showing of a pair: which item was shown first, and the judge's choice. */
export type Showing = { pair: Pair; first: string; second: string; verdict: Verdict };

/** The two showings of a pair: as scheduled, and swapped. */
export function showingsOf(pair: Pair): [{ first: string; second: string }, { first: string; second: string }] {
  return [
    { first: pair.a, second: pair.b },
    { first: pair.b, second: pair.a },
  ];
}

function winnerOf(showing: Showing): string | null {
  if (showing.verdict === "tie") return null;
  return showing.verdict === "first" ? showing.first : showing.second;
}

export type PairResult = { pair: Pair; winner: string | null; consistent: boolean };

/** A pair's result from its two showings. The same winner both times wins; anything else is a tie, and a flip is inconsistent. */
export function resolvePair(forward: Showing, swapped: Showing): PairResult {
  const one = winnerOf(forward);
  const two = winnerOf(swapped);
  if (one !== null && one === two) return { pair: forward.pair, winner: one, consistent: true };
  return { pair: forward.pair, winner: null, consistent: one === two };
}

/**
 * Bradley-Terry strengths from pair results (a tie is half a win each way). Each item also plays one virtual tie against an average
 * opponent of strength 1, a weak prior that keeps every strength finite. Strengths are scaled to a geometric mean of 1.
 */
export function bradleyTerry(ids: readonly string[], results: readonly PairResult[], iterations = 200): Map<string, number> {
  const strength = new Map(ids.map((id) => [id, 1]));
  const wins = new Map(ids.map((id) => [id, 0.5]));
  const games: { a: string; b: string }[] = [];
  for (const result of results) {
    const { a, b } = result.pair;
    if (!strength.has(a) || !strength.has(b)) continue;
    games.push({ a, b });
    if (result.winner === null) {
      wins.set(a, (wins.get(a) ?? 0) + 0.5);
      wins.set(b, (wins.get(b) ?? 0) + 0.5);
    } else {
      wins.set(result.winner, (wins.get(result.winner) ?? 0) + 1);
    }
  }
  for (let round = 0; round < iterations; round += 1) {
    const next = new Map<string, number>();
    for (const id of ids) {
      const own = strength.get(id)!;
      let denominator = 1 / (own + 1);
      for (const game of games) {
        if (game.a === id) denominator += 1 / (own + strength.get(game.b)!);
        else if (game.b === id) denominator += 1 / (own + strength.get(game.a)!);
      }
      next.set(id, wins.get(id)! / denominator);
    }
    const logMean = [...next.values()].reduce((total, value) => total + Math.log(value), 0) / Math.max(next.size, 1);
    const scale = Math.exp(logMean);
    for (const [id, value] of next) strength.set(id, value / scale);
  }
  return strength;
}

/** A strength on an Elo-like scale (1500 is average), easier for a person to read. */
export function ratingOf(strength: number): number {
  return Math.round(1500 + (400 * Math.log(strength)) / Math.LN10);
}

export type Reliability = {
  pairs: number;
  /** Pairs where both showings agreed (the same winner, or a tie both times). */
  consistent: number;
  consistency: number;
  /** How often the first-shown item won, over all decided showings. Near 0.5 when the judge has no position bias. */
  firstShownWinRate: number | null;
  /** True when the judge is not reliable enough for its ranking to choose: consistency under the floor. */
  unreliable: boolean;
};

/** The consistency floor under which a ranking is not used to choose (initial, hypothesis). */
export const CONSISTENCY_FLOOR = 0.6;

/** How far the judge can be trusted, from its showings and the resolved pairs. */
export function reliability(showings: readonly Showing[], results: readonly PairResult[]): Reliability {
  const decided = showings.filter((showing) => showing.verdict !== "tie");
  const firstWins = decided.filter((showing) => showing.verdict === "first").length;
  const consistent = results.filter((result) => result.consistent).length;
  const consistency = results.length === 0 ? 0 : consistent / results.length;
  return {
    pairs: results.length,
    consistent,
    consistency,
    firstShownWinRate: decided.length === 0 ? null : firstWins / decided.length,
    unreliable: results.length === 0 || consistency < CONSISTENCY_FLOOR,
  };
}

/** The ids ranked by strength, strongest first; equal strengths keep the input order. */
export function ranked(ids: readonly string[], strengths: Map<string, number>): { id: string; strength: number; rating: number }[] {
  return ids
    .map((id, index) => ({ id, index, strength: strengths.get(id) ?? 0 }))
    .sort((a, b) => b.strength - a.strength || a.index - b.index)
    .map(({ id, strength }) => ({ id, strength, rating: ratingOf(strength) }));
}
