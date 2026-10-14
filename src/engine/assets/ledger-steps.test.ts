import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { budgetReservationSchema, newId } from "../contracts/index.ts";
import { memoryLedgerStore, type LedgerStore } from "../budget/store.ts";
import type { LockableLedger } from "../gateway/paid.ts";
import { authorizeSubmit, reconcileSubmit } from "./ledger-steps.ts";

async function ledgerWithOneReservation(): Promise<{ ledger: LedgerStore; reservationId: string }> {
  const ledger = memoryLedgerStore();
  const reservationId = newId("res_");
  await ledger.createReservation(
    budgetReservationSchema.parse({
      schema: "meridian.budget_reservation/v1",
      reservationId,
      requestId: newId("req_"),
      workspaceId: "org_1",
      mode: "cap",
      lines: [{ stage: "produce_shot", estimateUsd: 5 }],
      estimateUsd: 5,
      redoAllowanceUsd: 0,
      reservedUsd: 5,
      state: "reserved",
      createdAt: "2026-10-14T10:00:00.000Z",
    }),
  );
  return { ledger, reservationId };
}

const call = (reservationId: string, key: string) => ({
  reservationId,
  stage: "produce_shot",
  provider: "openrouter",
  model: "kwaivgi/kling-v3.0-std",
  estimateUsd: 0.63,
  idempotencyKey: key,
  at: "2026-10-14T10:00:01.000Z",
});

describe("the submit's two budget steps", () => {
  it("each step runs under the ledger's lock when the ledger offers one, against the same store", async () => {
    const { ledger, reservationId } = await ledgerWithOneReservation();
    let locks = 0;
    const locked: LockableLedger = Object.assign(ledger, {
      withLock: async <T>(fn: (store: LedgerStore) => Promise<T>): Promise<T> => {
        locks += 1;
        return fn(ledger);
      },
    });

    const authorized = await authorizeSubmit(locked, call(reservationId, "sha256:key-a"));
    assert.equal(authorized.status, "authorized");
    assert.equal(locks, 1, "the authorize step takes the lock");

    const reconciled = await reconcileSubmit(locked, { idempotencyKey: "sha256:key-a", actualUsd: 0.6125 });
    assert.equal(reconciled.entry.actualUsd, 0.6125);
    assert.equal(locks, 2, "the reconcile step takes the lock too");
  });

  it("without a lock, the steps run against the ledger directly", async () => {
    const { ledger, reservationId } = await ledgerWithOneReservation();
    const first = await authorizeSubmit(ledger, call(reservationId, "sha256:key-b"));
    assert.equal(first.status, "authorized");
    const duplicate = await authorizeSubmit(ledger, call(reservationId, "sha256:key-b"));
    assert.equal(duplicate.status, "duplicate", "a key already used is not authorized again");
    const held = await ledger.getEntryByKey("sha256:key-b");
    assert.equal(held?.actualUsd, undefined, "authorize holds the estimate until reconcile");
  });

  it("reconciling with no bill and a list price records the list price as an estimate", async () => {
    const { ledger, reservationId } = await ledgerWithOneReservation();
    await authorizeSubmit(ledger, call(reservationId, "sha256:key-c"));
    const reconciled = await reconcileSubmit(ledger, { idempotencyKey: "sha256:key-c", listPriceUsd: 0.63 });
    assert.equal(reconciled.entry.actualUsd, 0.63);
    assert.equal(reconciled.entry.actualIsEstimate, true);
  });
});
