import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { budgetReservationSchema, type BudgetReservation } from "../contracts/index.ts";
import { memoryLedgerStore } from "../budget/store.ts";
import { createGateway } from "./gateway.ts";
import { paidCall } from "./paid.ts";
import { recorded, staticKeys } from "./test/recorded.ts";

const RESERVATION = "res_01JABCDEFGHJKMNPQRSTVWXYZ0";

async function ledgerWith(reservedUsd: number, state: "reserved" | "paused" = "reserved") {
  const ledger = memoryLedgerStore();
  const reservation: BudgetReservation = budgetReservationSchema.parse({
    schema: "meridian.budget_reservation/v1",
    reservationId: RESERVATION,
    requestId: "req_01JABCDEFGHJKMNPQRSTVWXYZ0",
    workspaceId: "org_1",
    mode: "cap",
    lines: [{ stage: "claude_roles", estimateUsd: reservedUsd }],
    estimateUsd: reservedUsd,
    redoAllowanceUsd: 0,
    reservedUsd,
    state,
    ...(state === "paused" ? { pausedReason: "budget" } : {}),
    createdAt: "2026-10-14T10:00:00.000Z",
  });
  await ledger.createReservation(reservation);
  return ledger;
}

function input(ledger: Awaited<ReturnType<typeof ledgerWith>>, estimateUsd: number, idempotencyKey = "sha256:call-1") {
  const gateway = createGateway({ transport: recorded([]).transport, credentials: staticKeys({}) });
  return { ledger, reservationId: RESERVATION, stage: "plan", route: gateway.route("llm.direction"), estimateUsd, idempotencyKey, at: "2026-10-14T10:01:00.000Z" };
}

describe("paid calls through the ledger", () => {
  it("authorizes, runs and records OpenRouter's actual cost", async () => {
    const ledger = await ledgerWith(1);
    let runs = 0;
    const outcome = await paidCall(input(ledger, 0.16), async () => {
      runs += 1;
      return { value: "plan", actualUsd: 0.1412 };
    });
    assert.equal(outcome.status, "done");
    assert.equal(runs, 1);
    const entry = await ledger.getEntryByKey("sha256:call-1");
    assert.equal(entry?.provider, "openrouter");
    assert.equal(entry?.model, "anthropic/claude-opus-5.5");
    assert.equal(entry?.actualUsd, 0.1412);
    assert.equal(entry?.settlement, "billed");
  });

  it("never runs a call the reservation cannot cover in cap mode", async () => {
    const ledger = await ledgerWith(0.1);
    let runs = 0;
    const outcome = await paidCall(input(ledger, 0.16), async () => {
      runs += 1;
      return { value: "plan", actualUsd: 0.16 };
    });
    assert.equal(outcome.status, "refused");
    assert.equal(runs, 0);
  });

  it("never runs a call on a paused reservation", async () => {
    const ledger = await ledgerWith(1, "paused");
    const outcome = await paidCall(input(ledger, 0.01), async () => ({ value: "x", actualUsd: 0.01 }));
    assert.equal(outcome.status, "refused");
  });

  it("does not run or bill the same idempotency key twice", async () => {
    const ledger = await ledgerWith(1);
    let runs = 0;
    const run = async () => {
      runs += 1;
      return { value: "plan", actualUsd: 0.1 };
    };
    await paidCall(input(ledger, 0.16), run);
    const second = await paidCall(input(ledger, 0.16), run);
    assert.equal(second.status, "duplicate");
    assert.equal(second.status === "duplicate" && second.samePayload, true);
    assert.equal(runs, 1);
  });

  it("leaves the call held at its reservation with no actual cost when the provider reports no bill (contract v6: an estimate is never an actual)", async () => {
    const ledger = await ledgerWith(1);
    const outcome = await paidCall(input(ledger, 0.16), async () => ({ value: "plan", actualUsd: null }));
    assert.equal(outcome.status, "done");
    const entry = await ledger.getEntryByKey("sha256:call-1");
    assert.equal(entry?.reservedUsd, 0.16);
    assert.equal(entry?.actualUsd, undefined);
    assert.equal(entry?.settlement, undefined);
  });

  it("keeps the hold when the call throws", async () => {
    const ledger = await ledgerWith(1);
    await assert.rejects(paidCall(input(ledger, 0.16), async () => Promise.reject(new Error("boom"))), /boom/);
    const entry = await ledger.getEntryByKey("sha256:call-1");
    assert.equal(entry?.reservedUsd, 0.16);
    assert.equal(entry?.actualUsd, undefined);
  });
});
