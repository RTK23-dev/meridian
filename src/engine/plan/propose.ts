// Step 2 of the visual decision engine: propose the candidate types for a shot (Bible 7.4). Pure code.
// The pool is the example's proposals in order, then the types of `may` requests, then the types a `must` allows, then
// the downgrade chain (7.1) of every generated candidate. The downgrade chain keeps a zero-cost route in the pool when
// the budget cannot pay for a generated type; without it a shot could have no route at all.

import type { VisualType, ReferenceShotType } from "../contracts/index.ts";
import { DOWNGRADE_TO, PROPERTY_TYPES, PROPOSALS, isGeneratedType } from "./tables.ts";
import type { Candidate, ClassifiedRequest } from "./types.ts";

export type ProposeInput = {
  refShot: ReferenceShotType;
  requests: readonly ClassifiedRequest[];
  mustAllowed: readonly VisualType[] | null;
};

/** The candidate pool for one shot, in order, with each type once (the first origin wins). */
export function proposeCandidates(input: ProposeInput): Candidate[] {
  const pool: Candidate[] = [];
  const seen = new Set<VisualType>();
  const add = (visualType: VisualType, origin: Candidate["origin"], proposalIndex: number | null): void => {
    if (!seen.has(visualType)) {
      seen.add(visualType);
      pool.push({ visualType, origin, proposalIndex });
    }
  };

  PROPOSALS[input.refShot].forEach((visualType, index) => add(visualType, "proposal", index));

  for (const request of input.requests) {
    if (request.strength !== "may") {
      continue;
    }
    for (const property of request.properties) {
      for (const visualType of PROPERTY_TYPES[property]) {
        add(visualType, "may", null);
      }
    }
  }

  for (const visualType of input.mustAllowed ?? []) {
    add(visualType, "must", null);
  }

  // Downgrade chains, transitively: a downgrade target that is itself generated has its own chain.
  for (let index = 0; index < pool.length; index++) {
    const candidate = pool[index];
    if (!isGeneratedType(candidate.visualType)) {
      continue;
    }
    for (const visualType of DOWNGRADE_TO[candidate.visualType]) {
      add(visualType, "downgrade", null);
    }
  }

  return pool;
}
