// Seeded randomness for the editor (Bible 8.2 step 13). The seed is the first 32 bits of a sha256 over the request id, so a
// re-run of the same request makes the same choices and a variant of it differs. The generator is mulberry32: small, pure and
// the same on every runtime.

import { createHash } from "node:crypto";
import { EngineError } from "../contracts/index.ts";

/** The seed for a request. An EDL carries it in its seed field (an unsigned 32-bit integer). */
export function seedFromRequestId(requestId: string): number {
  return createHash("sha256").update(`edit-seed:${requestId}`).digest().readUInt32BE(0);
}

export type Rng = { next(): number };

/** A generator of numbers in [0, 1). Two generators with the same seed give the same sequence. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return {
    next(): number {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** A weighted pick. Weights must be finite and non-negative with a positive total; the caller checks that. */
export function pickWeighted<T>(rng: Rng, items: readonly { value: T; weight: number }[]): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  const draw = rng.next() * total;
  let running = 0;
  for (const item of items) {
    running += item.weight;
    if (draw < running) return item.value;
  }
  const last = items[items.length - 1];
  if (last === undefined) throw new EngineError("invalid_input", "pickWeighted needs at least one item");
  return last.value;
}
