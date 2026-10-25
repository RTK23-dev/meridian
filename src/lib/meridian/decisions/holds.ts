// The budget hold for one OpenRouter Decisions call. It is the same ledger row shape as an ordinary text call (providers/generation-ledger.ts),
// so the workspace's monthly spend counts decisions and text together under one rule. The engine holds the call before it is sent and
// settles it once afterwards. A hold that cannot be written refuses the call; a settlement that cannot be written is logged and the hold
// stays in flight, so it still counts against the month.

import type { Sql } from "../learning/store.ts";
import type { Settlement, HoldInput, HoldResult } from "../providers/generation-ledger.ts";
import { reserveGenerationCall, settleGenerationCall } from "../providers/generation-ledger.ts";
import { loadDefaultSql } from "../credentials/resolve.ts";

export type DecisionHolds = {
  reserve(input: HoldInput, estimateUsd: number): Promise<HoldResult>;
  settle(holdId: string, settlement: Settlement): Promise<void>;
};

/** The ledger on the database `sqlOf` returns. The engine uses the default database; a test names its own. */
export function ledgerHoldsOn(sqlOf: () => Promise<Sql>): DecisionHolds {
  return {
    async reserve(input, estimateUsd) {
      try {
        return await reserveGenerationCall(await sqlOf(), input, estimateUsd);
      } catch {
        return { status: "refused", reason: "The budget hold could not be written, so nothing was sent." };
      }
    },
    async settle(holdId, settlement) {
      try {
        await settleGenerationCall(await sqlOf(), holdId, settlement);
      } catch {
        console.error(`decisions: the outcome of hold ${holdId} could not be recorded; the hold stays in flight and counts against the month.`);
      }
    },
  };
}

/** The production ledger: the workspace's model_runs rows. */
export function ledgerDecisionHolds(): DecisionHolds {
  return ledgerHoldsOn(loadDefaultSql);
}

/**
 * An in-memory ledger for tests. It approves each call within the per-call ceiling it is given, and it keeps what it was asked to settle.
 * It does not enforce a monthly budget, so a test of the monthly cap must use the database ledger.
 */
export function memoryDecisionHolds(): DecisionHolds & { settled: Array<{ holdId: string; settlement: Settlement }>; reserved: HoldInput[] } {
  const settled: Array<{ holdId: string; settlement: Settlement }> = [];
  const reserved: HoldInput[] = [];
  let counter = 0;
  return {
    settled,
    reserved,
    async reserve(input) {
      reserved.push(input);
      counter += 1;
      return { status: "held", id: `memory-hold-${counter}` };
    },
    async settle(holdId, settlement) {
      settled.push({ holdId, settlement });
    },
  };
}
