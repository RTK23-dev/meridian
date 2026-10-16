// The two budget steps of one submit, split apart so that a submit and its settlement can run in different job runs (Bible 14.1,
// 15.2). gateway/paid.ts runs authorize, the call and reconcile in one closure; an asynchronous call cannot, because the poll comes
// later. These helpers run the same budget functions with the same lock: each step runs under the reservation's row lock when the
// ledger offers withLock, and the provider call itself is never under the lock.

import { authorizeCall, type AuthorizeResult, type CallInput } from "../budget/reserve.ts";
import { reconcileCall, type ReconcileInput, type ReconcileResult } from "../budget/reconcile.ts";
import type { LedgerStore } from "../budget/store.ts";
import type { LockableLedger } from "../gateway/paid.ts";

async function budgetStep<T>(ledger: LockableLedger, step: (store: LedgerStore) => Promise<T>): Promise<T> {
  return ledger.withLock ? ledger.withLock(step) : step(ledger);
}

/** Authorize one submit before it is sent. A key already used returns the existing entry and nothing is sent again. */
export function authorizeSubmit(ledger: LockableLedger, input: CallInput): Promise<AuthorizeResult> {
  return budgetStep(ledger, (store) => authorizeCall(store, input));
}

/** Record what one submit cost. Reconciling a key twice changes nothing the second time (budget/reconcile.ts). */
export function reconcileSubmit(ledger: LockableLedger, input: ReconcileInput): Promise<ReconcileResult> {
  return budgetStep(ledger, (store) => reconcileCall(store, input));
}
