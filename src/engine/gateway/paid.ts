// A paid call through the budget ledger (Bible 14.1): authorize against the reservation, make the call, reconcile the actual
// cost. A refused call is never made. A duplicate idempotency key is never billed or made twice. A call that throws keeps
// its held amount on the ledger, so a provider that billed for a failure is never under-counted. What the call's provider
// request measured is kept as its telemetry row (telemetry.ts): in the same transaction as the settlement when the budget step
// has one, and never at the cost of the call's result or its ledger row.

import { authorizeCall, type BudgetAlert, type CallInput } from "../budget/reserve.ts";
import { reconcileCall } from "../budget/reconcile.ts";
import type { LedgerRow, LedgerStore } from "../budget/store.ts";
import type { ResolvedRoute } from "./gateway.ts";
import {
  callTelemetryOf,
  keepCallTelemetry,
  logTelemetryNotRecorded,
  newProbe,
  probeRequests,
  type CallTelemetryRecord,
  type CallTelemetryStore,
  type RequestProbe,
} from "./telemetry.ts";

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
 * The store a budget step runs in. It also keeps a call's telemetry when it offers recordCallTelemetry: a Postgres budget
 * transaction does (jobs/call-telemetry-sql.ts), so the row and the settlement share its transaction.
 */
export type BudgetStore = LedgerStore & Partial<CallTelemetryStore>;

/**
 * A ledger that can run one budget step under a lock. authorizeCall reads the reservation's committed total and then writes an
 * entry, so two calls on one reservation must not interleave (the budget README asks for a row lock). A Postgres ledger offers
 * withLock, which runs the step in one transaction under the reservation's row lock. A memory ledger has none, and the step runs
 * as it is. The lock covers the budget steps only: never the provider call itself.
 */
export type LockableLedger = LedgerStore & {
  withLock?: <T>(fn: (store: BudgetStore) => Promise<T>) => Promise<T>;
};

export type PaidRun<T> = { value: T; /** The provider's own bill, when it reports one (OpenRouter usage.cost). */ actualUsd: number | null };

export type PaidCallOutcome<T> =
  | { status: "done"; value: T; entry: LedgerRow; alerts: BudgetAlert[] }
  | { status: "refused"; reason: string; alerts: BudgetAlert[] }
  | { status: "duplicate"; entry: LedgerRow; samePayload: boolean };

/** The telemetry row of a call's entry, or null when no request reached the provider or the call belongs to no organization. */
function telemetryRecordOf(probe: RequestProbe, route: ResolvedRoute, entry: LedgerRow): CallTelemetryRecord | null {
  const telemetry = callTelemetryOf(probe.samples, { organizationId: entry.workspaceId, provider: route.provider.id, model: route.model });
  return telemetry === null ? null : { ...telemetry, ledgerEntryId: entry.entryId, organizationId: entry.workspaceId };
}

export async function paidCall<T>(input: PaidCallInput, run: () => Promise<PaidRun<T>>): Promise<PaidCallOutcome<T>> {
  const locked = input.ledger.withLock;
  const budgetStep = <R>(step: (store: BudgetStore) => Promise<R>): Promise<R> => (locked ? locked(step) : step(input.ledger));
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

  const probe = newProbe();
  const result = await probeRequests(probe, run).catch(async (error: unknown): Promise<never> => {
    // The call threw and keeps its hold. A request that reached the provider still has its telemetry kept. A failure to keep it is
    // only logged, so the caller sees the call's own error.
    const record = telemetryRecordOf(probe, input.route, authorized.entry);
    if (record !== null) await budgetStep((store) => keepCallTelemetry(store, record)).catch(logTelemetryNotRecorded);
    throw error;
  });

  const reconciled = await budgetStep(async (store) => {
    const settled = await reconcileCall(store, {
      idempotencyKey: input.idempotencyKey,
      ...(result.actualUsd === null ? {} : { billedUsd: result.actualUsd }),
    });
    // The row is written in the settlement's transaction, after the bill. keepCallTelemetry never throws, so a failed row leaves the bill.
    const record = telemetryRecordOf(probe, input.route, authorized.entry);
    if (record !== null) await keepCallTelemetry(store, record);
    return settled;
  });
  return { status: "done", value: result.value, entry: reconciled.entry, alerts: [...authorized.alerts, ...reconciled.alerts] };
}
