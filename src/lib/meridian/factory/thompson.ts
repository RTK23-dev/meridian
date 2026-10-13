import { betaMean, jeffreysPrior, updateBeta } from "../stats/beta.ts";

export type TestArm = {
  id: string;
  successes: number;
  trials: number;
  spendCents: number;
};

export type TestAllocation = {
  id: string;
  weight: number;
  pause: boolean;
  reason: string;
};

function unit(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

export function allocateTestBudget(input: {
  arms: TestArm[];
  minSpendCents: number;
  seed: string;
}): TestAllocation[] {
  if (input.arms.length === 0) return [];
  const draws = input.arms.map((arm) => {
    const posterior = updateBeta(jeffreysPrior(), arm.successes, arm.trials);
    const mean = betaMean(posterior);
    const noise = unit(`${input.seed}:${arm.id}`) * 0.02;
    const underMin = arm.spendCents < input.minSpendCents;
    return { arm, mean, draw: mean + noise, underMin };
  });
  const ready = draws.filter((item) => !item.underMin);
  const best = ready.length ? Math.max(...ready.map((item) => item.draw)) : 0;
  return draws.map((item) => {
    if (item.underMin) {
      return { id: item.arm.id, weight: 1 / input.arms.length, pause: false, reason: "Minimum spend has not been reached." };
    }
    if (item.draw < best * 0.6 && item.arm.trials >= 3) {
      return { id: item.arm.id, weight: 0, pause: true, reason: "Paused after minimum spend; posterior is behind the leader." };
    }
    return { id: item.arm.id, weight: item.draw, pause: false, reason: "Budget shifts toward the stronger posterior inside the cap." };
  });
}

/** A 32-bit FNV-1a hash of a string. The seed of a draw, so the same seed always gives the same draw. */
function fnv1a(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** A seeded generator of numbers in [0, 1) (mulberry32). Two generators with the same seed give the same numbers. */
function generatorFor(seed: string): () => number {
  let state = fnv1a(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function standardNormal(next: () => number): number {
  const u1 = Math.max(next(), 1e-12);
  const u2 = next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** A draw from Gamma(shape, 1), by Marsaglia and Tsang (2000). A shape below 1 is raised by one and scaled back down. */
function gammaDraw(shape: number, next: () => number): number {
  if (shape < 1) return gammaDraw(shape + 1, next) * Math.pow(Math.max(next(), 1e-12), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const x = standardNormal(next);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = next();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(Math.max(u, 1e-12)) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  // Unreached in practice: the acceptance test above accepts well within the attempts. The mode keeps the function total.
  return d;
}

/** A draw from Beta(alpha, beta), from two gamma draws. */
export function betaDraw(alpha: number, beta: number, next: () => number): number {
  const x = gammaDraw(alpha, next);
  const y = gammaDraw(beta, next);
  const total = x + y;
  return total > 0 ? x / total : 0.5;
}

/** One candidate for a ranking. Its successes and failures are observed counts; an arm with neither is untested. */
export type ThompsonArm = {
  id: string;
  successes: number;
  failures: number;
  /** A multiplier on the posterior draw, from what the brand has learned. 1 changes nothing; 0 removes the arm. */
  weight: number;
};

export type ThompsonRanked = { id: string; draw: number; score: number; rank: number };

/**
 * Thompson sampling for a ranking. Each arm gets one draw from its Beta posterior, starting from the Jeffreys prior, so an untested
 * arm (no successes and no failures) has the prior's wide spread and can win. A proven arm has a narrow posterior near its rate.
 * Each arm's generator is seeded from the seed and the arm's id, so the same seed and arms always give the same ranking, whatever
 * order the arms arrive in. The score is the draw times the arm's weight. The result is best first, with rank 1 at the top.
 */
export function thompsonRank(input: { arms: ThompsonArm[]; seed: string }): ThompsonRanked[] {
  const prior = jeffreysPrior();
  const ranked = input.arms.map((arm) => {
    const next = generatorFor(`${input.seed}:${arm.id}`);
    const draw = betaDraw(prior.alpha + Math.max(0, arm.successes), prior.beta + Math.max(0, arm.failures), next);
    const score = Math.round(draw * Math.max(0, arm.weight) * 1000) / 1000;
    return { id: arm.id, draw, score };
  });
  ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return ranked.map((item, index) => ({ ...item, rank: index + 1 }));
}
