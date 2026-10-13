import assert from "node:assert/strict";
import test from "node:test";
import { betaDraw, thompsonRank, type ThompsonArm } from "./thompson.ts";

const ARMS: ThompsonArm[] = [
  { id: "proven", successes: 40, failures: 10, weight: 1 },
  { id: "untested", successes: 0, failures: 0, weight: 1 },
  { id: "weak", successes: 1, failures: 19, weight: 1 },
];

/** Park-Miller generator for the beta test: a fixed sequence, so the sample mean is the same on every run. */
function parkMiller(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

function scoresById(ranked: Array<{ id: string; score: number }>): Record<string, number> {
  return Object.fromEntries(ranked.map((item) => [item.id, item.score]));
}

test("the same seed gives the same ranking, whatever order the arms arrive in", () => {
  const first = thompsonRank({ arms: ARMS, seed: "run-1" });
  assert.deepEqual(thompsonRank({ arms: ARMS, seed: "run-1" }), first);
  const reversed = thompsonRank({ arms: [...ARMS].reverse(), seed: "run-1" });
  assert.deepEqual(scoresById(reversed), scoresById(first), "each arm's draw depends on the seed and its id, not its place");
  assert.deepEqual(
    first.map((item) => item.rank),
    [1, 2, 3],
    "the ranks run from the top",
  );
});

test("a different seed gives different draws, so the seed is what makes a run's picks", () => {
  const draws = new Set<number>();
  for (let seed = 0; seed < 20; seed += 1) {
    const top = thompsonRank({ arms: [{ id: "a", successes: 0, failures: 0, weight: 1 }], seed: `seed-${seed}` })[0];
    if (top) draws.add(top.draw);
  }
  assert.ok(draws.size > 1, "across seeds the untested arm's draw varies");
});

test("a proven arm usually ranks first, and an untested arm still wins some runs, so the two are balanced", () => {
  const first = { proven: 0, untested: 0, weak: 0 };
  for (let seed = 0; seed < 300; seed += 1) {
    const top = thompsonRank({ arms: ARMS, seed: `run-${seed}` })[0];
    if (top && top.id in first) first[top.id as keyof typeof first] += 1;
  }
  assert.ok(first.proven > 150, `the proven arm ranks first in ${first.proven} of 300 seeds`);
  assert.ok(first.untested >= 10, `the untested arm ranks first in ${first.untested} of 300 seeds, so it is not starved`);
  assert.ok(first.weak <= 5, `the weak arm ranks first in ${first.weak} of 300 seeds`);
});

test("an arm weighted to zero scores zero and never ranks above an arm with a weight", () => {
  const ranked = thompsonRank({
    arms: [
      { id: "zero", successes: 50, failures: 0, weight: 0 },
      { id: "one", successes: 0, failures: 0, weight: 1 },
    ],
    seed: "weight",
  });
  assert.equal(ranked[0]?.id, "one");
  assert.equal(scoresById(ranked).zero, 0);
});

test("a beta draw stays between zero and one, and its mean follows its parameters", () => {
  const next = parkMiller(7);
  let total = 0;
  const count = 2000;
  for (let index = 0; index < count; index += 1) {
    const draw = betaDraw(2, 6, next);
    assert.ok(draw >= 0 && draw <= 1, `draw ${draw} is a probability`);
    total += draw;
  }
  const mean = total / count;
  // Beta(2, 6) has mean 0.25. With 2000 draws the standard error is about 0.003.
  assert.ok(mean > 0.22 && mean < 0.28, `sample mean ${mean.toFixed(3)} is near 0.25`);
});
