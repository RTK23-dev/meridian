import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authorizeCall } from "../budget/reserve.ts";
import { releaseReservation } from "../budget/reconcile.ts";
import { memoryLedgerStore, type LedgerStore } from "../budget/store.ts";
import { budgetReservationSchema, EngineError, type BudgetReservation } from "../contracts/index.ts";
import { extendForVariants, type VariantReservationInput } from "./reserve.ts";

const REQUEST = "req_01JABCDEFGHJKMNPQRSTVWXYZ0";
const RESERVATION = "res_01JABCDEFGHJKMNPQRSTVWXYZ0";
const OTHER_RESERVATION = "res_01JABCDEFGHJKMNPQRSTVWXYZ1";
const WORKSPACE = "ws_test";
const CREATED = "2026-10-14T10:00:00.000Z";
const NOW = "2026-10-14T11:00:00.000Z";

function reservation(overrides: Partial<BudgetReservation> = {}): BudgetReservation {
  return budgetReservationSchema.parse({
    schema: "meridian.budget_reservation/v1",
    reservationId: RESERVATION,
    requestId: REQUEST,
    workspaceId: WORKSPACE,
    mode: "cap",
    lines: [{ stage: "claude_roles", estimateUsd: 1 }],
    estimateUsd: 1,
    redoAllowanceUsd: 0,
    reservedUsd: 1,
    state: "reserved",
    createdAt: CREATED,
    ...overrides,
  });
}

/** A ledger with the reservation held at 1 USD, of which 0.3 USD is committed by one call (held as its estimate until reconciled). */
async function ledgerWithCommitment(overrides: Partial<BudgetReservation> = {}): Promise<LedgerStore> {
  const ledger = memoryLedgerStore();
  await ledger.createReservation(reservation(overrides));
  const authorized = await authorizeCall(ledger, {
    reservationId: RESERVATION,
    stage: "render",
    provider: "fixture-render",
    model: "fixture-model",
    estimateUsd: 0.3,
    idempotencyKey: "key-committed-1",
    at: CREATED,
  });
  assert.equal(authorized.status, "authorized");
  return ledger;
}

function raise(overrides: Partial<VariantReservationInput> = {}): VariantReservationInput {
  return {
    reservationId: RESERVATION,
    requestBudgetUsd: 2,
    workspaceMonthBudgetUsd: 100,
    plannedUsd: 0.9,
    now: NOW,
    ...overrides,
  };
}

async function heldOf(ledger: LedgerStore): Promise<number> {
  const found = await ledger.getReservation(RESERVATION);
  assert.ok(found);
  return found.reservedUsd;
}

describe("the variants' hold on the request's reservation (Bible 6.13, 14.1)", () => {
  it("raises the hold to the committed spend plus the funded variants, and says by how much", async () => {
    const ledger = await ledgerWithCommitment();
    const result = await extendForVariants(ledger, raise());
    assert.deepEqual(result, { status: "held", reservedUsd: 1.2, extensionUsd: 0.2, changed: true });
    assert.equal(await heldOf(ledger), 1.2);
  });

  it("writes nothing when the hold already covers the funded variants", async () => {
    const ledger = await ledgerWithCommitment();
    const result = await extendForVariants(ledger, raise({ plannedUsd: 0.5 }));
    assert.deepEqual(result, { status: "held", reservedUsd: 1, extensionUsd: 0, changed: false });
    assert.equal(await heldOf(ledger), 1);
  });

  it("is idempotent: the same plan raised twice holds the same amount and writes nothing the second time", async () => {
    const ledger = await ledgerWithCommitment();
    await extendForVariants(ledger, raise());
    const again = await extendForVariants(ledger, raise());
    assert.deepEqual(again, { status: "held", reservedUsd: 1.2, extensionUsd: 0, changed: false });
    assert.equal(await heldOf(ledger), 1.2);
  });

  it("refuses a raise above the request budget, with the reason, and leaves the hold as it was", async () => {
    const ledger = await ledgerWithCommitment();
    const result = await extendForVariants(ledger, raise({ plannedUsd: 2, requestBudgetUsd: 2 }));
    assert.equal(result.status, "refused");
    if (result.status !== "refused") return;
    assert.match(result.reason, /above the request budget of 2 USD/);
    assert.equal(await heldOf(ledger), 1);
  });

  it("refuses a raise that would pass the workspace month budget, with the reason", async () => {
    const ledger = await ledgerWithCommitment();
    await ledger.createReservation(reservation({ reservationId: OTHER_RESERVATION, reservedUsd: 98, estimateUsd: 98, lines: [{ stage: "claude_roles", estimateUsd: 98 }] }));
    const result = await extendForVariants(ledger, raise({ workspaceMonthBudgetUsd: 99 }));
    assert.equal(result.status, "refused");
    if (result.status !== "refused") return;
    assert.match(result.reason, /workspace monthly budget of 99 USD would be exceeded/);
    assert.equal(await heldOf(ledger), 1);
  });

  it("refuses a raise when the workspace month budget is not connected, and still holds a funding that needs no raise", async () => {
    const ledger = await ledgerWithCommitment();
    const refused = await extendForVariants(ledger, raise({ workspaceMonthBudgetUsd: null }));
    assert.equal(refused.status, "refused");
    if (refused.status === "refused") assert.match(refused.reason, /monthly budget is not connected/);
    const held = await extendForVariants(ledger, raise({ workspaceMonthBudgetUsd: null, plannedUsd: 0.5 }));
    assert.deepEqual(held, { status: "held", reservedUsd: 1, extensionUsd: 0, changed: false });
  });

  it("funds nothing on a paused reservation, and says why", async () => {
    const ledger = memoryLedgerStore();
    await ledger.createReservation(reservation({ state: "paused", pausedReason: "budget paused it" }));
    const result = await extendForVariants(ledger, raise());
    assert.equal(result.status, "refused");
    if (result.status === "refused") assert.match(result.reason, /is paused: budget paused it; no variant is funded/);
  });

  it("does not raise a reservation of another month", async () => {
    const ledger = await ledgerWithCommitment();
    const result = await extendForVariants(ledger, raise({ now: "2026-11-02T09:00:00.000Z" }));
    assert.equal(result.status, "refused");
    if (result.status === "refused") assert.match(result.reason, /cannot be raised in 2026-11/);
  });

  it("throws not_found for a reservation that does not exist, and invalid_input for an amount that is not one", async () => {
    const ledger = memoryLedgerStore();
    await assert.rejects(extendForVariants(ledger, raise()), (error: unknown) => error instanceof EngineError && error.kind === "not_found");
    const held = await ledgerWithCommitment();
    await assert.rejects(extendForVariants(held, raise({ plannedUsd: -1 })), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  });

  it("is released at deliver: the release shrinks the hold to what was committed, so the unspent variant money goes back", async () => {
    const ledger = await ledgerWithCommitment();
    const raised = await extendForVariants(ledger, raise());
    assert.equal(raised.status, "held");
    const released = await releaseReservation(ledger, RESERVATION);
    assert.equal(released.reservation.state, "released");
    assert.equal(released.reservation.reservedUsd, 0.3);
    assert.equal(released.releasedUsd, 0.9);
  });
});
