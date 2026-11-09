// Every paid connector call runs under a hold on its brand's budget (the Billing page), as Studio and Factory media do: the hold is reserved
// before the provider is called, so a brand with no budget set, or not enough left, sends nothing. A call that sent nothing releases its
// hold. A call that may have reached the provider and then failed keeps its hold, because it may have been billed, and says so. A call that
// succeeded settles at the cost the provider reported, or, when it reported none, at the hold's ceiling under the same estimator Studio and
// Factory images use, so the budget never undercounts what may have been spent.

import { BudgetLedgerService, toMicros, toUsd, type CostObservation } from "../security/budget-ledger.ts";
import type { Sql } from "../learning/store.ts";

/** The estimator a ceiling settlement is recorded under; the same label as production/materialization.ts UNPRICED_CEILING_ESTIMATOR. */
export const UNPRICED_CEILING_ESTIMATOR = "unpriced-ceiling-v1";

/** Thrown by a call that refused before anything was sent: its hold is released. */
export class NotSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSentError";
  }
}

export type HoldLedger = {
  reserve(input: { organizationId: string; brandId: string; amountMicros: bigint }): Promise<{ id: string }>;
  settle(input: { reservationId: string; cost: CostObservation }): Promise<void>;
  release(input: { reservationId: string; reason: string }): Promise<void>;
};

export function sqlHoldLedger(sql: Sql): HoldLedger {
  return {
    reserve: (input) => BudgetLedgerService.reserve(sql, input),
    async settle(input) {
      await BudgetLedgerService.reconcile(sql, { reservationId: input.reservationId, cost: input.cost });
    },
    async release(input) {
      await BudgetLedgerService.release(sql, { reservationId: input.reservationId, reason: input.reason, actor: "mcp-connector" });
    },
  };
}

export type HeldOutcome<T> =
  | { ok: true; value: T; costUsd: number | null; settledUsd: number; basis: "reported" | "ceiling" }
  | { ok: false; reason: string; held: boolean };

export const usd = (value: number) => `$${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;

/** Runs one paid call under a hold of `ceilingUsd` on the brand's budget. */
export async function withBrandHold<T>(
  ledger: HoldLedger,
  input: { organizationId: string; brandId: string; ceilingUsd: number; purpose: string },
  call: () => Promise<{ value: T; costUsd: number | null }>,
): Promise<HeldOutcome<T>> {
  let reservationId: string;
  try {
    ({ id: reservationId } = await ledger.reserve({ organizationId: input.organizationId, brandId: input.brandId, amountMicros: toMicros(input.ceilingUsd) }));
  } catch (error) {
    return { ok: false, held: false, reason: `${error instanceof Error ? error.message : "The brand budget refused the hold."} Nothing was sent.` };
  }
  let outcome: { value: T; costUsd: number | null };
  try {
    outcome = await call();
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : `The ${input.purpose} failed.`;
    if (error instanceof NotSentError) {
      await ledger.release({ reservationId, reason: `${input.purpose}: not sent. ${message}` }).catch(() => undefined);
      return { ok: false, held: false, reason: `${message} Nothing was sent, and the hold was released.` };
    }
    return { ok: false, held: true, reason: `${message} The provider may have been reached, so ${usd(input.ceilingUsd)} stays held on the brand budget until it is reconciled.` };
  }
  const reported = outcome.costUsd !== null && Number.isFinite(outcome.costUsd) && outcome.costUsd >= 0 ? outcome.costUsd : null;
  const cost: CostObservation = reported !== null
    ? { basis: "PROVIDER_ACTUAL", amountMicros: toMicros(reported) }
    : { basis: "ESTIMATED", amountMicros: toMicros(input.ceilingUsd), estimatorVersion: UNPRICED_CEILING_ESTIMATOR };
  await ledger.settle({ reservationId, cost });
  return { ok: true, value: outcome.value, costUsd: reported, settledUsd: toUsd(cost.amountMicros), basis: reported !== null ? "reported" : "ceiling" };
}
