import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryLedgerStore, type LedgerStore } from "../budget/store.ts";
import { committedFor } from "../budget/reserve.ts";
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

const OPEN_ENTRY_ID = fixtureId("led_", 40);

/** The chain fixture's reservation with its four settled calls, and one call that never came back (no actual cost). */
async function ledgerWithOpenCall(): Promise<LedgerStore> {
  const ledger = memoryLedgerStore();
  await ledger.createReservation(budgetReservationFixture);
  const settled: LedgerEntry[] = [ledgerClaudeFixture, ledgerSttFixture, ledgerShot3Fixture, ledgerRenderFixture];
  for (const entry of settled) {
    await ledger.appendEntry({ ...entry, workspaceId: budgetReservationFixture.workspaceId, reservationId: budgetReservationFixture.reservationId });
  }
  const open: LedgerEntry = {
    entryId: OPEN_ENTRY_ID,
    requestId: FIXTURE_IDS.request,
    stage: "produce_shot",
    provider: "openrouter",
    model: "avatar-iv",
    estimateUsd: 0.15,
    reservedUsd: 0.15,
    idempotencyKey: "produce:shot1:1",
    at: "2026-10-13T09:03:00.000Z",
  };
  await ledger.appendEntry({ ...open, workspaceId: budgetReservationFixture.workspaceId, reservationId: budgetReservationFixture.reservationId });
  return ledger;
}

describe("settling the ledger at delivery (Bible 14.1 steps 4 and 5)", () => {
  it("reconciles the open call as a flagged estimate, then releases the reservation to what is committed", async () => {
    const ledger = await ledgerWithOpenCall();
    const settled = await settleLedger(ledger, budgetReservationFixture.reservationId);

    assert.deepEqual(settled.reconciled, [OPEN_ENTRY_ID]);
    assert.equal(settled.rows.length, 5);
    assert.ok(settled.rows.every((row) => typeof row.actualUsd === "number"), "every row has an actual cost");

    const open = settled.rows.find((row) => row.idempotencyKey === "produce:shot1:1");
    assert.equal(open?.actualUsd, 0.15, "the open call is held at its estimate");
    assert.equal(open?.actualIsEstimate, true, "and flagged as an estimate, not a bill");

    // 0.142 (planner) + 0.02 (speech) + 0.2016 (shot 3) + 0.047 (render) + 0.15 (open call) = 0.5606
    const reservation = await ledger.getReservation(budgetReservationFixture.reservationId);
    assert.equal(reservation?.state, "released");
    assert.equal(reservation?.reservedUsd, 0.5606);
    assert.equal(settled.release.releasedUsd, 0.3989, "0.9595 reserved less 0.5606 committed");
  });

  it("is idempotent: a second run reconciles nothing and releases nothing", async () => {
    const ledger = await ledgerWithOpenCall();
    await settleLedger(ledger, budgetReservationFixture.reservationId);
    const again = await settleLedger(ledger, budgetReservationFixture.reservationId);
    assert.deepEqual(again.reconciled, []);
    assert.equal(again.release.releasedUsd, 0);
    assert.equal(again.rows.length, 5);
  });

  it("keeps the committed total of the reservation unchanged by the release", async () => {
    const ledger = await ledgerWithOpenCall();
    const before = await committedFor(ledger, budgetReservationFixture.reservationId);
    await settleLedger(ledger, budgetReservationFixture.reservationId);
    assert.equal(await committedFor(ledger, budgetReservationFixture.reservationId), before);
  });

  it("refuses a reservation that does not exist", async () => {
    const ledger = memoryLedgerStore();
    await assert.rejects(settleLedger(ledger, FIXTURE_IDS.reservation), (error: unknown) => error instanceof EngineError && error.kind === "not_found");
  });
});
