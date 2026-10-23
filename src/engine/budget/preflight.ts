// The pre-flight hold and its extension (Bible 6.1 step 8, 6.5 and 14.1; lead decision, recorded in budget/README.md).
//
// The paid stages before the plan (analyze_reference, voice, plan) need a reservation to authorize against, but no plan
// exists yet. So intake reserves the fixed per-master lines only (budgets.fixedPerMasterUsd, Bible 14.2): reserveFixed.
// estimate_reserve then raises that same reservation to the full plan estimate, plus the redo allowance: extendReservation.
// The fixed lines stay inside the plan's lines, because the plan's lines include them.
//
// Both steps note a hold that is above the request budget or the workspace month. A note is never a refusal: a budget is a line
// (owner direction 2026-10-23, D12), and a call starts only while its line is below the budget (reserve.ts, authorizeCall).
// A reservation is never lowered below what it has committed.

import { z } from "zod";
import {
  budgetModeSchema,
  budgetReservationSchema,
  canonicalJson,
  EngineError,
  idSchema,
  newId,
  roundUsd,
  sumUsd,
  usdSchema,
  type BudgetMode,
  type BudgetReservation,
  type ScenePlan,
} from "../contracts/index.ts";
import { estimatePlan, fixedBudgetLines, type ChosenCallPrices } from "./estimate.ts";
import { committedFor, overBudgetNote, type BudgetAlert, type ReserveResult } from "./reserve.ts";
import type { LedgerStore } from "./store.ts";

const RESERVE_FIXED_STAGE = "intake";
const EXTEND_STAGE = "estimate_reserve";

function invalid(message: string, stage: string): EngineError {
  return new EngineError("invalid_input", message, { stage });
}

function requestIdIn(value: unknown, stage: string): string {
  const parsed = idSchema("req_").safeParse(value);
  if (!parsed.success) throw invalid("requestId must be a req_ id", stage);
  return parsed.data;
}

function reservationIdIn(value: unknown, stage: string): string {
  const parsed = idSchema("res_").safeParse(value);
  if (!parsed.success) throw invalid("reservationId must be a res_ id", stage);
  return parsed.data;
}

function workspaceIdIn(value: unknown, stage: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalid("workspaceId must be a non-empty string", stage);
  return value;
}

function modeIn(value: unknown, stage: string): BudgetMode {
  const parsed = budgetModeSchema.safeParse(value);
  if (!parsed.success) throw invalid("mode must be observe, warn or cap", stage);
  return parsed.data;
}

type Limits = { requestBudgetUsd: number; workspaceMonthBudgetUsd: number; now: string };
type LimitsInput = { requestBudgetUsd: number; workspaceMonthBudgetUsd: number; now: string };

/** The two budgets and the time, checked. `now` decides the workspace month, as in reserve(). */
function limitsIn(input: LimitsInput, stage: string): Limits {
  const request = usdSchema.safeParse(input.requestBudgetUsd);
  if (!request.success) throw invalid("requestBudgetUsd must be a USD amount, finite, >= 0, at most 4 decimals", stage);
  const month = usdSchema.safeParse(input.workspaceMonthBudgetUsd);
  if (!month.success) throw invalid("workspaceMonthBudgetUsd must be a USD amount, finite, >= 0, at most 4 decimals", stage);
  const time = z.iso.datetime().safeParse(input.now);
  if (!time.success) throw invalid("now must be an ISO time", stage);
  return { requestBudgetUsd: request.data, workspaceMonthBudgetUsd: month.data, now: time.data };
}

/**
 * The notes of a hold that is above a budget (D12): an alert for each budget it is above. A note is never a refusal. The messages match
 * reserve() so that the notes read the same wherever they appear.
 */
function budgetNotesOf(limits: Limits, holdUsd: number, monthUsd: number): BudgetAlert[] {
  const alerts: BudgetAlert[] = [];
  if (holdUsd > limits.requestBudgetUsd) alerts.push(overBudgetNote("request", holdUsd, limits.requestBudgetUsd));
  if (monthUsd > limits.workspaceMonthBudgetUsd) alerts.push(overBudgetNote("workspace_month", monthUsd, limits.workspaceMonthBudgetUsd));
  return alerts;
}

export type ReserveFixedInput = {
  requestId: string;
  workspaceId: string;
  mode: BudgetMode;
  /** ProductionRequest.constraints.budgetUsd. */
  requestBudgetUsd: number;
  /** The workspace's monthly budget for the month of `now`. */
  workspaceMonthBudgetUsd: number;
  /** ISO time of the reservation. Its month decides which monthly budget applies. */
  now: string;
  /** Pass an id to make the call idempotent: a second call with the same id returns the first reservation. */
  reservationId?: string;
};

/**
 * The pre-flight hold (intake). It holds the fixed per-master lines only (budgets.fixedPerMasterUsd, 14.2), with no redo
 * allowance and no shot lines. A hold above a budget is held with a note (D12): calls are gated by their line, not by the hold.
 * - cap and warn: it is held and the notes are returned.
 * - observe: it is held and recorded; no note.
 * Idempotent on reservationId: a repeated call returns the stored reservation and stores nothing new.
 */
export async function reserveFixed(store: LedgerStore, input: ReserveFixedInput): Promise<ReserveResult> {
  const stage = RESERVE_FIXED_STAGE;
  const requestId = requestIdIn(input.requestId, stage);
  const workspaceId = workspaceIdIn(input.workspaceId, stage);
  const mode = modeIn(input.mode, stage);
  const limits = limitsIn(input, stage);
  const reservationId = input.reservationId === undefined ? undefined : reservationIdIn(input.reservationId, stage);

  if (reservationId !== undefined) {
    const existing = await store.getReservation(reservationId);
    if (existing) {
      return { reservation: existing, alerts: [], created: false };
    }
  }

  const lines = fixedBudgetLines();
  const fixedUsd = sumUsd(lines.map((line) => line.estimateUsd));
  const totals = await store.sumForMonth(workspaceId, limits.now.slice(0, 7));
  const alerts = budgetNotesOf(limits, fixedUsd, sumUsd([totals.reservedUsd, fixedUsd]));

  const reservation: BudgetReservation = budgetReservationSchema.parse({
    schema: "meridian.budget_reservation/v1",
    reservationId: reservationId ?? newId("res_"),
    requestId,
    workspaceId,
    mode,
    lines,
    estimateUsd: fixedUsd,
    redoAllowanceUsd: 0,
    reservedUsd: fixedUsd,
    requestBudgetUsd: limits.requestBudgetUsd,
    workspaceMonthBudgetUsd: limits.workspaceMonthBudgetUsd,
    state: "reserved",
    createdAt: limits.now,
  });
  await store.createReservation(reservation);
  return { reservation, alerts: mode === "observe" ? [] : alerts, created: true };
}

export type ExtendReservationInput = {
  reservationId: string;
  /** The scene plan. Its estimate (shots, fixed lines and redo allowance) is the new hold. */
  plan: ScenePlan;
  /** ProductionRequest.constraints.budgetUsd. */
  requestBudgetUsd: number;
  /** The workspace's monthly budget for the month of the reservation (and of `now`, which must be the same month). */
  workspaceMonthBudgetUsd: number;
  now: string;
  /** The catalog prices of the calls whose model the orchestrator chose (Bible 10.5). Absent: every call is priced from the price table. */
  chosenPrices?: ChosenCallPrices;
};

export type ExtendResult =
  /** The hold is the plan's estimate (or it was already). `changed` is false when nothing was written. A hold above a budget is noted. */
  | { status: "extended"; reservation: BudgetReservation; changed: boolean; alerts: BudgetAlert[] }
  /** The reservation cannot be extended: it is not reserved, it is from another month, or the plan is below the commitment. */
  | { status: "refused"; reservation: BudgetReservation; reason: string };

/**
 * Raise a pre-flight hold to the plan's estimate (estimate_reserve). The reservation's lines become the plan's lines, which
 * include the fixed lines, and its hold becomes the plan's reserved amount (estimate plus redo allowance).
 * - The hold is never lowered: it is the larger of the plan's amount and what it holds already.
 * - A plan amount below what the reservation has committed is refused. The plan does not cover what was already spent.
 * - A reservation that is paused or released is refused: it holds nothing and is not revived here.
 * - A hold above a budget is written with a note (D12). Calls are gated by their line, not by the hold.
 * - An unknown price or an invalid plan throws before anything is read or stored.
 * Idempotent: extending again with the same plan writes nothing.
 */
export async function extendReservation(store: LedgerStore, input: ExtendReservationInput): Promise<ExtendResult> {
  const stage = EXTEND_STAGE;
  const reservationId = reservationIdIn(input.reservationId, stage);
  const limits = limitsIn(input, stage);
  const estimate = estimatePlan(input.plan, input.chosenPrices);

  const current = await store.getReservation(reservationId);
  if (!current) {
    throw new EngineError("not_found", `reservation ${reservationId} does not exist`, { stage });
  }

  if (current.state !== "reserved") {
    const why = current.pausedReason === undefined ? "" : `: ${current.pausedReason}`;
    return {
      status: "refused",
      reservation: current,
      reason: `reservation ${reservationId} is ${current.state}${why}; only a reserved reservation is extended`,
    };
  }

  // The hold is counted in the month it was made (ledger store, sumForMonth). Extending it in another month would put
  // the new amount in a month whose budget was never checked, so that is refused and a new reservation is needed.
  const month = limits.now.slice(0, 7);
  if (month !== current.createdAt.slice(0, 7)) {
    return {
      status: "refused",
      reservation: current,
      reason: `reservation ${reservationId} was made in ${current.createdAt.slice(0, 7)} and cannot be extended in ${month}; make a new reservation`,
    };
  }

  const committedUsd = await committedFor(store, reservationId);
  if (estimate.reservedUsd < committedUsd) {
    return {
      status: "refused",
      reservation: current,
      reason: `the plan estimate of ${estimate.reservedUsd} USD is below the ${committedUsd} USD already committed to ${reservationId}; the hold is not lowered`,
    };
  }

  const holdUsd = roundUsd(Math.max(estimate.reservedUsd, current.reservedUsd));
  const next: BudgetReservation = budgetReservationSchema.parse({
    ...current,
    lines: estimate.lines,
    estimateUsd: estimate.estimateUsd,
    redoAllowanceUsd: estimate.redoAllowanceUsd,
    reservedUsd: holdUsd,
    requestBudgetUsd: limits.requestBudgetUsd,
    workspaceMonthBudgetUsd: limits.workspaceMonthBudgetUsd,
  });

  // The month total already includes this reservation at its current hold. Swap that for the new hold.
  const totals = await store.sumForMonth(current.workspaceId, month);
  const otherReservationsUsd = roundUsd(Math.max(0, totals.reservedUsd - current.reservedUsd));
  const alerts = budgetNotesOf(limits, holdUsd, sumUsd([otherReservationsUsd, holdUsd]));

  const changed = canonicalJson(next) !== canonicalJson(current);
  if (changed) {
    await store.updateReservation(next);
  }
  return {
    status: "extended",
    reservation: changed ? next : current,
    changed,
    alerts: current.mode === "observe" ? [] : alerts,
  };
}
