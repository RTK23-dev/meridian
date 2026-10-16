// Tuned values (Bible 16.3): every tuned value has a floor, a ceiling and a maximum change per night.
// Logic reads tuned values through clampTunable, so a bad learned value cannot move a gate or a weight far.

import { EngineError } from "../contracts/errors.ts";

export type Tunable = {
  readonly value: number;
  readonly floor: number;
  readonly ceiling: number;
};

/** Initial maximum change per night, as a share of the current value (Bible 16.3). */
export const MAX_NIGHTLY_CHANGE_SHARE = 0.15;

/** Build a tuned value. Throws at load time if the initial value is outside its own bounds. */
export function tunable(value: number, floor: number, ceiling: number): Tunable {
  if (![value, floor, ceiling].every(Number.isFinite) || floor > value || value > ceiling) {
    throw new EngineError("config", `tunable ${value} must satisfy floor ${floor} <= value <= ceiling ${ceiling}`);
  }
  return { value, floor, ceiling };
}

/**
 * Clamp a proposed value. The move from the current value is limited to maxChangeShare of the current value,
 * then the result is held inside [floor, ceiling]. A non-finite proposal keeps the current value (fail closed).
 * A current value of 0 cannot move under the relative rule; no initial tunable is 0.
 */
export function clampTunable(next: number, current: Tunable, maxChangeShare: number = MAX_NIGHTLY_CHANGE_SHARE): number {
  if (!(maxChangeShare >= 0 && maxChangeShare <= 1)) {
    throw new EngineError("config", "maxChangeShare must be between 0 and 1");
  }
  if (!Number.isFinite(next)) {
    return current.value;
  }
  const maxDelta = Math.abs(current.value) * maxChangeShare;
  const low = Math.max(current.floor, current.value - maxDelta);
  const high = Math.min(current.ceiling, current.value + maxDelta);
  return Math.min(high, Math.max(low, next));
}
