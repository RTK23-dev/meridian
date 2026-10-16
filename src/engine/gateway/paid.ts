// A paid call through the budget ledger (Bible 14.1): authorize against the reservation, make the call, reconcile the actual
// cost. A refused call is never made. A duplicate idempotency key is never billed or made twice. A call that throws keeps
// its held amount on the ledger, so a provider that billed for a failure is never under-counted.

import { authorizeCall, type BudgetAlert, type CallInput } from "../budget/reserve.ts";
import { reconcileCall } from "../budget/reconcile.ts";
import type { LedgerRow, LedgerStore } from "../budget/store.ts";
import type { ResolvedRoute } from "./gateway.ts";

export type PaidCallInput = {
  ledger: LockableLedger;
  reservationId: string;
  stage: string;
  route: ResolvedRoute;
  estimateUsd: number;
  /** The input hash of the call. */
  idempotencyKey: string;
  /** ISO time of the call. */
  at: string;
  /** A Claude call's role and prompt version, recorded on the ledger entry (contract v2). Set both or neither. */
  role?: CallInput["role"];
  promptVersion?: string;
};

/**
 * A ledger that can run one budget step under a lock. authorizeCall reads the reservation's committed total and then writes an
 * entry, so two calls on one reservation must not interleave (the budget README asks for a row lock). A Postgres ledger offers
 * withLock, which runs the step in one transaction under the reservation's row lock. A memory ledger has none, and the step runs
 * as it is. The lock covers the budget steps only: never the provider call itself.
 */
export type LockableLedger = LedgerStore & {
  withLock?: <T>(fn: (store: LedgerStore) => Promise<T>) => Promise<T>;
};

export type PaidRun<T> = { value: T; /** The provider's own bill, when it reports one (OpenRouter usage.cost). */ actualUsd: number | null };

export type PaidCallOutcome<T> =
  | { status: "done"; value: T; entry: LedgerRow; alerts: BudgetAlert[] }
  | { status: "refused"; reason: string; alerts: BudgetAlert[] }
  | { status: "duplicate"; entry: LedgerRow; samePayload: boolean };

export async function paidCall<T>(input: PaidCallInput, run: () => Promise<PaidRun<T>>): Promise<PaidCallOutcome<T>> {
  const locked = input.ledger.withLock;
  const budgetStep = <R>(step: (store: LedgerStore) => Promise<R>): Promise<R> => (locked ? locked(step) : step(input.ledger));
  const authorized = await budgetStep((store) =>
    authorizeCall(store, {
      reservationId: input.reservationId,
      stage: input.stage,
      provider: input.route.provider.id,
      model: input.route.model,
      estimateUsd: input.estimateUsd,
      idempotencyKey: input.idempotencyKey,
      at: input.at,
      ...(input.role === undefined ? {} : { role: input.role, promptVersion: input.promptVersion }),
    }),
  );
  if (authorized.status === "refused") return { status: "refused", reason: authorized.reason, alerts: authorized.alerts };
  if (authorized.status === "duplicate") return { status: "duplicate", entry: authorized.entry, samePayload: authorized.samePayload };

  const result = await run();
  const reconciled = await budgetStep((store) =>
    reconcileCall(store, {
      idempotencyKey: input.idempotencyKey,
      ...(result.actualUsd === null ? {} : { actualUsd: result.actualUsd }),
    }),
  );
  return { status: "done", value: result.value, entry: reconciled.entry, alerts: [...authorized.alerts, ...reconciled.alerts] };
}
