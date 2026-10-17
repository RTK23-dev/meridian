import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryLedgerStore, type LedgerStore } from "../budget/store.ts";
import { committedFor } from "../budget/reserve.ts";
import { confirmAbsentCall, reconcileCall } from "../budget/reconcile.ts";
import { EngineError, type LedgerEntry } from "../contracts/index.ts";
import {
  budgetReservationFixture,
  fixtureId,
  FIXTURE_IDS,
  ledgerClaudeFixture,
  ledgerRenderFixture,
  ledgerShot3Fixture,
  ledgerSttFixture,
} from "../contracts/fixtures/index.ts";
import { settleLedger } from "./ledger.ts";

const OPEN_KEY = "produce:shot1:1";

/** The chain fixture's reservation with its four settled calls, and one call that has no settled cost yet. */
async function ledgerWithOpenCall(): Promise<LedgerStore> {
  const ledger = memoryLedgerStore();
  await ledger.createReservation(budgetReservationFixture);
  const settled: LedgerEntry[] = [ledgerClaudeFixture, ledgerSttFixture, ledgerShot3Fixture, ledgerRenderFixture];
  for (const entry of settled) {
    await ledger.appendEntry({ ...entry, workspaceId: budgetReservationFixture.workspaceId, reservationId: budgetReservationFixture.reservationId });
  }
  const open: LedgerEntry = {
    entryId: fixtureId("led_", 40),
    requestId: FIXTURE_IDS.request,
    stage: "produce_shot",
    provider: "openrouter",
    model: "avatar-iv",
    estimateUsd: 0.15,
    reservedUsd: 0.15,
    idempotencyKey: OPEN_KEY,
    at: "2026-10-13T09:03:00.000Z",
    providerRef: null,
  };
  await ledger.appendEntry({ ...open, workspaceId: budgetReservationFixture.workspaceId, reservationId: budgetReservationFixture.reservationId });
  return ledger;
}

describe("settling the ledger at delivery (Bible 14.1 steps 4 and 5, contract v6)", () => {
  it("refuses to deliver while a call has no settled cost, names it, and releases nothing", async () => {
    const ledger = await ledgerWithOpenCall();
    await assert.rejects(settleLedger(ledger, budgetReservationFixture.reservationId), (error: unknown) => {
      return error instanceof EngineError && error.kind === "conflict" && error.message.includes(OPEN_KEY);
    });
    const reservation = await ledger.getReservation(budgetReservationFixture.reservationId);
    assert.equal(reservation?.state, "reserved", "a refused delivery leaves the reservation as it was");
  });

  it("delivers once the open call has its bill, and releases the reservation to what is committed", async () => {
    const ledger = await ledgerWithOpenCall();
    await reconcileCall(ledger, { idempotencyKey: OPEN_KEY, billedUsd: 0.15 });
    const settled = await settleLedger(ledger, budgetReservationFixture.reservationId);

    assert.equal(settled.rows.length, 5);
    assert.ok(settled.rows.every((row) => typeof row.actualUsd === "number"), "every row has a settled cost");
    const open = settled.rows.find((row) => row.idempotencyKey === OPEN_KEY);
    assert.equal(open?.actualUsd, 0.15);
    assert.equal(open?.settlement, "billed");

    // 0.142 (planner) + 0.02 (speech) + 0.2016 (shot 3) + 0.047 (render) + 0.15 (open call) = 0.5606
    const reservation = await ledger.getReservation(budgetReservationFixture.reservationId);
    assert.equal(reservation?.state, "released");
    assert.equal(reservation?.reservedUsd, 0.5606);
    assert.equal(settled.release.releasedUsd, 0.3989, "0.9595 reserved less 0.5606 committed");
  });

  it("delivers when the provider confirmed the open call absent: it settles at 0 and its hold is released", async () => {
    const ledger = await ledgerWithOpenCall();
    await confirmAbsentCall(ledger, { idempotencyKey: OPEN_KEY, evidence: "the provider confirmed no job exists for the key" });
    const settled = await settleLedger(ledger, budgetReservationFixture.reservationId);
    const open = settled.rows.find((row) => row.idempotencyKey === OPEN_KEY);
    assert.equal(open?.actualUsd, 0);
    assert.equal(open?.settlement, "confirmed_absent");
    assert.equal(settled.release.releasedUsd, 0.5489, "0.9595 reserved less 0.4106 committed");
  });

  it("is idempotent: a second run releases nothing", async () => {
    const ledger = await ledgerWithOpenCall();
    await reconcileCall(ledger, { idempotencyKey: OPEN_KEY, billedUsd: 0.15 });
    await settleLedger(ledger, budgetReservationFixture.reservationId);
    const again = await settleLedger(ledger, budgetReservationFixture.reservationId);
    assert.equal(again.release.releasedUsd, 0);
    assert.equal(again.rows.length, 5);
  });

  it("keeps the committed total of the reservation unchanged by the release", async () => {
    const ledger = await ledgerWithOpenCall();
    await reconcileCall(ledger, { idempotencyKey: OPEN_KEY, billedUsd: 0.15 });
    const before = await committedFor(ledger, budgetReservationFixture.reservationId);
    await settleLedger(ledger, budgetReservationFixture.reservationId);
    assert.equal(await committedFor(ledger, budgetReservationFixture.reservationId), before);
  });

  it("refuses a reservation that does not exist", async () => {
    const ledger = memoryLedgerStore();
    await assert.rejects(settleLedger(ledger, FIXTURE_IDS.reservation), (error: unknown) => error instanceof EngineError && error.kind === "not_found");
  });
});
