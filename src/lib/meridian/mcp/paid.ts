// Every paid connector call runs under a hold, as Studio and Factory media do: the hold is reserved before the provider is called, so a
// call with no budget, or not enough left, sends nothing. A call that sent nothing releases its hold. A call that may have reached the
// provider and then failed keeps its hold, because it may have been billed, and says so. A call that succeeded settles at the cost the
// provider reported, or, when it reported none, at the hold's ceiling under the same estimator Studio and Factory images use, so the budget
// never undercounts what may have been spent.
//
// Which budget: a call for a brand holds on that brand's budget (the Billing page). A call for a video made without a brand (owner
// direction 2026-11-09) holds on the workspace's monthly budget, through the same ledger ordinary paid generation uses
// (providers/generation-ledger.ts): the hold is a model_runs row counted against the month, a call that may have been billed stays as an
// uncertain hold an admin can check and release (Billing), and a workspace with no monthly budget is refused.

import { randomUUID } from "node:crypto";
import { BudgetLedgerService, toMicros, toUsd, type CostObservation } from "../security/budget-ledger.ts";
import { reserveGenerationCall, settleGenerationCall } from "../providers/generation-ledger.ts";
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

/** brandId null: a video made without a brand, held on the workspace's monthly budget. */
export type HoldLedger = {
  reserve(input: { organizationId: string; brandId: string | null; amountMicros: bigint; purpose: string; model: string }): Promise<{ id: string }>;
  settle(input: { reservationId: string; brandId: string | null; cost: CostObservation }): Promise<void>;
  release(input: { reservationId: string; brandId: string | null; reason: string }): Promise<void>;
  /** A call that may have reached the provider: the hold stays. On the monthly budget it is marked uncertain, for an admin to check. */
  keep(input: { reservationId: string; brandId: string | null; reason: string }): Promise<void>;
};

export function sqlHoldLedger(sql: Sql): HoldLedger {
  return {
    async reserve(input) {
      if (input.brandId !== null) return BudgetLedgerService.reserve(sql, { organizationId: input.organizationId, brandId: input.brandId, amountMicros: input.amountMicros });
      const held = await reserveGenerationCall(
        sql,
        {
          organizationId: input.organizationId,
          brandId: null,
          correlationId: `mcp:${randomUUID()}`,
          operation: `mcp.${input.purpose}`,
          promptId: "mcp-connector",
          promptVersion: "mcp-connector-v1",
          inputRef: "",
          provider: "openrouter",
          model: input.model,
          modelSource: "mcp-connector",
        },
        toUsd(input.amountMicros),
      );
      if (held.status === "refused") throw new Error(held.reason);
      return { id: held.id };
    },
    async settle(input) {
      if (input.brandId !== null) {
        await BudgetLedgerService.reconcile(sql, { reservationId: input.reservationId, cost: input.cost });
        return;
      }
      // A reported cost is the cost; with none, the held spend counts the hold's estimate (its ceiling), so the month never undercounts.
      const reported = input.cost.basis === "PROVIDER_ACTUAL" ? toUsd(input.cost.amountMicros) : null;
      const settled = await settleGenerationCall(sql, input.reservationId, {
        status: "completed",
        output: "",
        latencyMs: 0,
        tokens: null,
        returnedModel: null,
        generationId: null,
        costUsd: reported,
        error: "",
      });
      if (!settled) throw new Error("The hold on the monthly budget could not be settled; it stays held.");
    },
    async release(input) {
      if (input.brandId !== null) {
        await BudgetLedgerService.release(sql, { reservationId: input.reservationId, reason: input.reason, actor: "mcp-connector" });
        return;
      }
      await settleGenerationCall(sql, input.reservationId, { status: "failed", error: input.reason, latencyMs: 0 });
    },
    async keep(input) {
      if (input.brandId !== null) return;
      await settleGenerationCall(sql, input.reservationId, { status: "uncertain", error: input.reason, latencyMs: 0 });
    },
  };
}

export type HeldOutcome<T> =
  | { ok: true; value: T; costUsd: number | null; settledUsd: number; basis: "reported" | "ceiling" }
  | { ok: false; reason: string; held: boolean };

export const usd = (value: number) => `$${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;

/** The budget a call is paid from, in words. */
export function budgetName(brandId: string | null): string {
  return brandId === null ? "the workspace's monthly budget" : "the brand budget";
}

const NOTHING_SENT = "Nothing was sent.";
const withNothingSent = (reason: string) => (reason.trim().endsWith(NOTHING_SENT) ? reason.trim() : `${reason.trim()} ${NOTHING_SENT}`);

/** Runs one paid call under a hold of `ceilingUsd`: on the brand's budget, or on the workspace's monthly budget when brandId is null. */
export async function withHold<T>(
  ledger: HoldLedger,
  input: { organizationId: string; brandId: string | null; ceilingUsd: number; purpose: string; model: string },
  call: () => Promise<{ value: T; costUsd: number | null }>,
): Promise<HeldOutcome<T>> {
  const budget = budgetName(input.brandId);
  let reservationId: string;
  try {
    ({ id: reservationId } = await ledger.reserve({ organizationId: input.organizationId, brandId: input.brandId, amountMicros: toMicros(input.ceilingUsd), purpose: input.purpose, model: input.model }));
  } catch (error) {
    return { ok: false, held: false, reason: withNothingSent(error instanceof Error && error.message ? error.message : `${budget[0]!.toUpperCase()}${budget.slice(1)} refused the hold.`) };
  }
  let outcome: { value: T; costUsd: number | null };
  try {
    outcome = await call();
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : `The ${input.purpose} failed.`;
    if (error instanceof NotSentError) {
      await ledger.release({ reservationId, brandId: input.brandId, reason: `${input.purpose}: not sent. ${message}` }).catch(() => undefined);
      return { ok: false, held: false, reason: `${message} Nothing was sent, and the hold was released.` };
    }
    await ledger.keep({ reservationId, brandId: input.brandId, reason: `${input.purpose}: ${message}` }).catch(() => undefined);
    return { ok: false, held: true, reason: `${message} The provider may have been reached, so ${usd(input.ceilingUsd)} stays held on ${budget} until it is reconciled.` };
  }
  const reported = outcome.costUsd !== null && Number.isFinite(outcome.costUsd) && outcome.costUsd >= 0 ? outcome.costUsd : null;
  const cost: CostObservation = reported !== null
    ? { basis: "PROVIDER_ACTUAL", amountMicros: toMicros(reported) }
    : { basis: "ESTIMATED", amountMicros: toMicros(input.ceilingUsd), estimatorVersion: UNPRICED_CEILING_ESTIMATOR };
  await ledger.settle({ reservationId, brandId: input.brandId, cost });
  return { ok: true, value: outcome.value, costUsd: reported, settledUsd: toUsd(cost.amountMicros), basis: reported !== null ? "reported" : "ceiling" };
}
