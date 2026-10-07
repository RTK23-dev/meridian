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
