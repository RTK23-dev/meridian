// The two budget steps of one submit, split apart so that a submit and its settlement can run in different job runs (Bible 14.1,
// 15.2). gateway/paid.ts runs authorize, the call and reconcile in one closure; an asynchronous call cannot, because the poll comes
// later. These helpers run the same budget functions with the same lock: each step runs under the reservation's row lock when the
// ledger offers withLock, and the provider call itself is never under the lock.

import { EngineError } from "../contracts/index.ts";
import { authorizeCall, type AuthorizeResult, type CallInput } from "../budget/reserve.ts";
import { confirmAbsentCall, reconcileCall, type ReconcileInput, type ReconcileResult } from "../budget/reconcile.ts";
import type { LedgerStore } from "../budget/store.ts";
import type { LockableLedger } from "../gateway/paid.ts";

async function budgetStep<T>(ledger: LockableLedger, step: (store: LedgerStore) => Promise<T>): Promise<T> {
  return ledger.withLock ? ledger.withLock(step) : step(ledger);
}

/** Authorize one submit before it is sent. A key already used returns the existing entry and nothing is sent again. */
export function authorizeSubmit(ledger: LockableLedger, input: CallInput): Promise<AuthorizeResult> {
  return budgetStep(ledger, (store) => authorizeCall(store, input));
}

/**
 * Settle one submit to the provider's verified bill. Without a bill the submit stays held: nothing is estimated (contract v6).
 * Settling a key twice with the same bill changes nothing; a different bill is a conflict (budget/reconcile.ts).
 */
export function reconcileSubmit(ledger: LockableLedger, input: ReconcileInput): Promise<ReconcileResult> {
  return budgetStep(ledger, (store) => reconcileCall(store, input));
}

/**
 * Settle one submit as absent: the provider refused it before any job id existed, so no job was created. Used only for a definitive
 * refusal (router.ts, DEFINITIVE_REFUSALS), with the refusal as its evidence.
 */
export function confirmAbsentSubmit(ledger: LockableLedger, input: { idempotencyKey: string; evidence: string }): Promise<ReconcileResult> {
  return budgetStep(ledger, (store) => confirmAbsentCall(store, input));
}

/**
 * Operator resolution of an ambiguous submit: a submit whose outcome was unknown (a server error, a timeout, or an answer without a
 * job id) may have been billed. The operator settles it from the provider's invoice (`billed`) or from the provider's own record that no
 * job exists (`absent`). Either settles the entry and releases nothing else; a re-run of the asset then sees the settled entry.
 */
export type AmbiguousResolution = { kind: "billed"; billedUsd: number; evidence: string } | { kind: "absent"; evidence: string };

export function resolveAmbiguousSubmit(ledger: LockableLedger, idempotencyKey: string, resolution: AmbiguousResolution): Promise<ReconcileResult> {
  if (resolution.evidence.trim().length === 0) {
    throw new EngineError("invalid_input", "resolving an ambiguous submit needs the evidence it rests on");
  }
  if (resolution.kind === "absent") return confirmAbsentSubmit(ledger, { idempotencyKey, evidence: resolution.evidence });
  return reconcileSubmit(ledger, { idempotencyKey, billedUsd: resolution.billedUsd });
}
