// Settle each paid call to its real cost, then release what was not spent (Video Engine Bible 14.1 steps 4 and 5, as amended for
// contract v6). A call's actual cost is the provider's verified bill, or a confirmation that the call created no job. An estimate is
// never an actual. Without a bill or a confirmation the call stays held at its reservation, and the hold counts toward the budget.

import { budgetReservationSchema, EngineError, providerRefSchema, roundUsd, sumUsd, type BudgetReservation } from "../contracts/index.ts";
import { committedFor, type BudgetAlert } from "./reserve.ts";
import { startsBelowLine } from "./line.ts";
import type { LedgerRow, LedgerStore } from "./store.ts";

export type ReconcileInput = {
  /** The idempotency key the call was authorized with. */
  idempotencyKey: string;
  /** The provider's verified bill for the call. Omit when the provider reported none: the call then stays held, and nothing is estimated. */
  billedUsd?: number;
  /**
   * The provider's own id for the call (contract v9: a Deepgram request id, an OpenRouter generation id). It is recorded whether or not a
   * bill is given, so a call held without its bill can be settled later from its id (budget/reconcile-holds.ts).
   */
  providerRef?: string;
};

export type ReconcileResult = {
  entry: LedgerRow;
  reservation: BudgetReservation;
  alerts: BudgetAlert[];
  /** True when the entry is settled: a bill is recorded, now or before. False while the call stays held. */
  settled: boolean;
};

async function loadCall(store: LedgerStore, idempotencyKey: string): Promise<{ row: LedgerRow; reservation: BudgetReservation }> {
  const row = await store.getEntryByKey(idempotencyKey);
  if (!row) {
    throw new EngineError("not_found", `no ledger entry for idempotency key ${idempotencyKey}`);
  }
  const reservation = await store.getReservation(row.reservationId);
  if (!reservation) {
    throw new EngineError("not_found", `reservation ${row.reservationId} does not exist`, { stage: row.stage });
  }
  return { row, reservation };
}

/**
 * A bill in the ledger's four decimals (usdSchema, the contract's money type). The bill is rounded UP. Rounding to nearest can record up
 * to $0.00005 less than the provider billed, which under-counts a hard budget. Rounding up records at most $0.0001 more, the safe side.
 * Six decimals would need a contract change and a column change (actual_usd is numeric(14, 4)), so they are an owner decision.
 */
function billUsdUp(usd: number): number {
  // The small offset stops a bill that is already on four decimals from rounding up through floating-point noise.
  return Math.ceil(usd * 10000 - 1e-6) / 10000;
}

/**
 * Settle a call to the provider's verified bill. Settling a call twice with the same bill changes nothing; a different bill for a
 * settled call is a conflict. The bill is recorded even when it is above the call's authorized amount: it was spent. What happens
 * next depends on the reservation's mode and its lines (settleAndCheck).
 */
export async function reconcileCall(store: LedgerStore, input: ReconcileInput): Promise<ReconcileResult> {
  const loaded = await loadCall(store, input.idempotencyKey);
  const reservation = loaded.reservation;
  let row = loaded.row;
  if (input.providerRef !== undefined) {
    const checked = providerRefSchema.safeParse(input.providerRef);
    if (!checked.success) {
      throw new EngineError("invalid_input", "a provider ref must be a non-empty id of at most 512 characters", { stage: row.stage });
    }
    if ((row.providerRef ?? null) !== input.providerRef) {
      row = await store.setProviderRef(row.entryId, input.providerRef);
    }
  }
  if (input.billedUsd === undefined) {
    return { entry: row, reservation, alerts: [], settled: row.settlement !== undefined };
  }
  if (!Number.isFinite(input.billedUsd) || input.billedUsd < 0) {
    throw new EngineError("invalid_input", `a verified bill must be a finite, non-negative USD amount, not ${input.billedUsd}`);
  }
  // The ledger keeps four decimals, as the contract's money type does. The bill is rounded up to them, never estimated and never down.
  const billed = billUsdUp(input.billedUsd);
  if (row.settlement !== undefined) {
    if (row.settlement === "billed" && row.actualUsd === billed) return { entry: row, reservation, alerts: [], settled: true };
    throw new EngineError("conflict", `ledger entry ${row.entryId} is already settled as ${row.settlement}`, { stage: row.stage });
  }
  const entry = await store.settle(row.entryId, { actualUsd: billed, settlement: "billed" });
  return settleAndCheck(store, reservation, entry);
}

/**
 * Settle a call the provider confirmed created no job (a definitive refusal before any job id, Bible 10.4). Its actual cost is 0 by that
 * confirmation, and its hold is released with the reservation. `evidence` says what the provider said, for the audit trail.
 */
export async function confirmAbsentCall(store: LedgerStore, input: { idempotencyKey: string; evidence: string }): Promise<ReconcileResult> {
  if (input.evidence.trim().length === 0) {
    throw new EngineError("invalid_input", "a confirmed absence needs the evidence it rests on");
  }
  const { row, reservation } = await loadCall(store, input.idempotencyKey);
  if (row.settlement !== undefined) {
    if (row.settlement === "confirmed_absent") return { entry: row, reservation, alerts: [], settled: true };
    throw new EngineError("conflict", `ledger entry ${row.entryId} is already settled as ${row.settlement}`, { stage: row.stage });
  }
  const entry = await store.settle(row.entryId, { actualUsd: 0, settlement: "confirmed_absent" });
  return settleAndCheck(store, reservation, entry);
}

/** The reservation's state with a new reason, or without the reason when it is reserved again (contract: exceeded needs a reason). */
function withState(reservation: BudgetReservation, state: "reserved" | "exceeded", reason?: string): BudgetReservation {
  const { pausedReason: _previous, ...rest } = reservation;
  return budgetReservationSchema.parse(state === "exceeded" ? { ...rest, state, pausedReason: reason } : { ...rest, state });
}

/**
 * After a call settles (D12). The reservation's committed spend is compared with its hold: when it is above, the hold is raised to it and
 * the overrun is an alert, in every mode but observe. In cap mode the reservation is marked exceeded only at a line: when the request's
 * committed spend (every reservation of the request) or the workspace month's committed spend is at or above its budget. It is not marked
 * for an overrun of its hold alone, and a mark clears when no line is reached any more. Warn raises the hold and returns the alerts;
 * observe raises it silently.
 */
async function settleAndCheck(store: LedgerStore, reservation: BudgetReservation, entry: LedgerRow): Promise<ReconcileResult> {
  const committedUsd = await committedFor(store, reservation.reservationId);
  const holdOverrun = committedUsd > reservation.reservedUsd;
  if (reservation.mode !== "cap" && !holdOverrun) {
    return { entry, reservation, alerts: [], settled: true };
  }

  const requestBudget = reservation.requestBudgetUsd;
  const monthBudget = reservation.workspaceMonthBudgetUsd;
  const requestCommittedUsd = await store.committedForRequest(reservation.requestId);
  const monthCommittedUsd = monthBudget === undefined ? 0 : await store.committedForMonth(reservation.workspaceId, entry.at.slice(0, 7));
  const requestAtLine = requestBudget !== undefined && !startsBelowLine(requestCommittedUsd, requestBudget);
  const monthAtLine = monthBudget !== undefined && !startsBelowLine(monthCommittedUsd, monthBudget);
  const atLine = requestAtLine || monthAtLine;

  const message = `settled ${entry.stage} call takes reservation ${reservation.reservationId} to ${committedUsd} USD, above its ${reservation.reservedUsd} USD`;
  const alerts: BudgetAlert[] = [];
  if (holdOverrun) {
    alerts.push({ kind: "overrun", scope: "call", limitUsd: reservation.reservedUsd, committedUsd, message });
  }
  if (requestBudget !== undefined && requestCommittedUsd > requestBudget) {
    alerts.push({
      kind: "overrun",
      scope: "request",
      limitUsd: requestBudget,
      committedUsd: requestCommittedUsd,
      message: `the request's settled spend is ${requestCommittedUsd} USD, above its ${requestBudget} USD budget`,
    });
  }
  if (reservation.mode === "cap" && monthBudget !== undefined && monthCommittedUsd > monthBudget) {
    alerts.push({
      kind: "overrun",
      scope: "workspace_month",
      limitUsd: monthBudget,
      committedUsd: monthCommittedUsd,
      message: `the workspace month's settled spend is ${monthCommittedUsd} USD, above its ${monthBudget} USD budget`,
    });
  }

  let next: BudgetReservation = holdOverrun ? { ...reservation, reservedUsd: roundUsd(committedUsd) } : reservation;
  if (reservation.mode === "cap") {
    const lineReason = requestAtLine
      ? `the request has committed ${requestCommittedUsd} USD, at or above its ${requestBudget} USD budget`
      : `the workspace month has committed ${monthCommittedUsd} USD, at or above its ${monthBudget} USD budget`;
    const reason = `${lineReason}; no further paid call starts while it is at its budget line`;
    if (atLine && (reservation.state === "reserved" || reservation.state === "exceeded")) {
      next = withState(next, "exceeded", reason);
    } else if (!atLine && reservation.state === "exceeded") {
      next = withState(next, "reserved");
    }
  }
  if (next !== reservation) {
    await store.updateReservation(next);
  }
  return {
    entry,
    reservation: next,
    alerts: reservation.mode === "observe" ? [] : alerts,
    settled: true,
  };
}

export type ReleaseResult = {
  reservation: BudgetReservation;
  releasedUsd: number;
};

/**
 * Release the unused part of a reservation (Bible 14.1 step 5). The reservation's amount drops to what is committed, so the monthly
 * total gives back the rest. A call that is still held keeps its hold, so a reservation with an unsettled call releases nothing for it.
 * Releasing twice is a no-op, and so is releasing a reservation that is paused or exceeded.
 */
export async function releaseReservation(store: LedgerStore, reservationId: string): Promise<ReleaseResult> {
  const reservation = await store.getReservation(reservationId);
  if (!reservation) {
    throw new EngineError("not_found", `reservation ${reservationId} does not exist`);
  }
  if (reservation.state !== "reserved") {
    return { reservation, releasedUsd: 0 };
  }

  const committedUsd = await committedFor(store, reservationId);
  const releasedUsd = roundUsd(Math.max(0, reservation.reservedUsd - committedUsd));
  const released: BudgetReservation = {
    ...reservation,
    state: "released",
    reservedUsd: roundUsd(committedUsd),
  };
  await store.updateReservation(released);
  return { reservation: released, releasedUsd };
}

/** The held amount of the reservation's calls that have no settlement yet, in USD. Operators read this to see what is unresolved. */
export async function unsettledHoldUsd(store: LedgerStore, reservationId: string): Promise<number> {
  const rows = await store.listEntries(reservationId);
  return sumUsd(rows.filter((row) => row.settlement === undefined).map((row) => row.reservedUsd));
}
