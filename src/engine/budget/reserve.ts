// Reserve before any paid call (Bible 14.1 steps 2 and 3). A budget that would be exceeded pauses the request
// rather than failing it. Each paid call is authorized against its reservation first, and a duplicate key never
// bills twice.

import {
  budgetReservationSchema,
  EngineError,
  idSchema,
  ledgerEntrySchema,
  newId,
  roundUsd,
  sumUsd,
  usdSchema,
  type BudgetMode,
  type BudgetReservation,
  type ClaudeRole,
  type ScenePlan,
} from "../contracts/index.ts";
import { estimatePlan, type ChosenCallPrices } from "./estimate.ts";
import { allowanceUsd, INITIAL_BUDGET_TOLERANCE, type BudgetTolerance } from "./tolerance.ts";
import type { LedgerRow, LedgerStore } from "./store.ts";

function usdInput(value: number, name: string): number {
  const parsed = usdSchema.safeParse(value);
  if (!parsed.success) {
    throw new EngineError("invalid_input", `${name} must be a USD amount, finite, >= 0, at most 4 decimals`);
  }
  return parsed.data;
}

function reservationIdInput(value: string): string {
  const parsed = idSchema("res_").safeParse(value);
  if (!parsed.success) {
    throw new EngineError("invalid_input", `reservationId ${value} is not a res_ id`);
  }
  return parsed.data;
}

export type BudgetAlert = {
  kind: "overrun";
  scope: "request" | "workspace_month" | "call";
  limitUsd: number;
  committedUsd: number;
  message: string;
};

export type ReserveInput = {
  requestId: string;
  workspaceId: string;
  mode: BudgetMode;
  plan: ScenePlan;
  /** ProductionRequest.constraints.budgetUsd. */
  requestBudgetUsd: number;
  /** The workspace's monthly budget for the month of `now`. */
  workspaceMonthBudgetUsd: number;
  /** ISO time of the reservation. Its month decides which monthly budget applies. */
  now: string;
  /** Pass an id to make the call idempotent: a second call with the same id returns the first reservation. */
  reservationId?: string;
  /** The catalog prices of the calls whose model the orchestrator chose (Bible 10.5). Absent: the price table prices every call. */
  chosenPrices?: ChosenCallPrices;
  /** The overrun tolerance on both budgets (owner direction 2026-10-23). Absent: the initial tolerance. */
  tolerance?: BudgetTolerance;
};

export type ReserveResult = {
  reservation: BudgetReservation;
  alerts: BudgetAlert[];
  /** False when the reservation already existed and nothing new was stored. */
  created: boolean;
};

/**
 * Reserve the plan's estimate against the request budget and the workspace month.
 * - cap: a reservation that would exceed either budget is stored as paused, with the reasons.
 * - warn: it is reserved and an overrun alert is returned.
 * - observe: it is reserved and recorded; no alert.
 * An unknown price throws UnknownPriceError before anything is stored.
 */
export async function reserve(store: LedgerStore, input: ReserveInput): Promise<ReserveResult> {
  usdInput(input.requestBudgetUsd, "requestBudgetUsd");
  usdInput(input.workspaceMonthBudgetUsd, "workspaceMonthBudgetUsd");

  if (input.reservationId !== undefined) {
    const existing = await store.getReservation(reservationIdInput(input.reservationId));
    if (existing) {
      return { reservation: existing, alerts: [], created: false };
    }
  }

  const reservationId = input.reservationId ?? newId("res_");
  const estimate = estimatePlan(input.plan, input.chosenPrices ?? new Map());
  const reservedUsd = estimate.reservedUsd;

  const tolerance = input.tolerance ?? INITIAL_BUDGET_TOLERANCE;
  const requestAllowanceUsd = allowanceUsd(input.requestBudgetUsd, tolerance);
  const monthAllowanceUsd = allowanceUsd(input.workspaceMonthBudgetUsd, tolerance);
  const reasons: string[] = [];
  const alerts: BudgetAlert[] = [];

  if (reservedUsd > input.requestBudgetUsd) {
    const message = `request budget ${input.requestBudgetUsd} USD is below the reservation of ${reservedUsd} USD`;
    if (reservedUsd > requestAllowanceUsd) reasons.push(`${message}, past its allowance of ${requestAllowanceUsd} USD (the budget plus its tolerance)`);
    alerts.push({
      kind: "overrun",
      scope: "request",
      limitUsd: input.requestBudgetUsd,
      committedUsd: reservedUsd,
      message,
    });
  }

  const totals = await store.sumForMonth(input.workspaceId, input.now.slice(0, 7));
  const monthCommittedUsd = sumUsd([totals.reservedUsd, reservedUsd]);
  if (monthCommittedUsd > input.workspaceMonthBudgetUsd) {
    const message = `workspace monthly budget ${input.workspaceMonthBudgetUsd} USD would be exceeded: ${monthCommittedUsd} USD committed`;
    if (monthCommittedUsd > monthAllowanceUsd) reasons.push(`${message}, past its allowance of ${monthAllowanceUsd} USD (the budget plus its tolerance)`);
    alerts.push({
      kind: "overrun",
      scope: "workspace_month",
      limitUsd: input.workspaceMonthBudgetUsd,
      committedUsd: monthCommittedUsd,
      message,
    });
  }

  const paused = input.mode === "cap" && reasons.length > 0;
  const reservation: BudgetReservation = budgetReservationSchema.parse({
    schema: "meridian.budget_reservation/v1",
    reservationId,
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    mode: input.mode,
    lines: estimate.lines,
    estimateUsd: estimate.estimateUsd,
    redoAllowanceUsd: estimate.redoAllowanceUsd,
    reservedUsd,
    requestBudgetUsd: input.requestBudgetUsd,
    workspaceMonthBudgetUsd: input.workspaceMonthBudgetUsd,
    requestAllowanceUsd,
    workspaceMonthAllowanceUsd: monthAllowanceUsd,
    state: paused ? "paused" : "reserved",
    ...(paused ? { pausedReason: reasons.join("; ") } : {}),
    createdAt: input.now,
  });

  await store.createReservation(reservation);
  return {
    reservation,
    alerts: input.mode === "observe" ? [] : alerts,
    created: true,
  };
}

export type CallInput = {
  reservationId: string;
  stage: string;
  provider: string;
  model: string;
  /** The call's list estimate. It is held against the reservation until the call is reconciled. */
  estimateUsd: number;
  /** The input hash of the call. A second call with the same key never bills again. */
  idempotencyKey: string;
  /** ISO time of the call. */
  at: string;
  entryId?: string;
  /** A Claude call's role and prompt version (LedgerEntry, contract v2). Set both or neither. */
  role?: ClaudeRole;
  promptVersion?: string;
};

export type AuthorizeResult =
  | { status: "authorized"; entry: LedgerRow; alerts: BudgetAlert[] }
  | { status: "duplicate"; entry: LedgerRow; samePayload: boolean }
  | { status: "refused"; reason: string; alerts: BudgetAlert[] };

function samePayload(row: LedgerRow, input: CallInput): boolean {
  return (
    row.reservationId === input.reservationId &&
    row.stage === input.stage &&
    row.provider === input.provider &&
    row.model === input.model &&
    row.estimateUsd === input.estimateUsd &&
    row.role === input.role &&
    row.promptVersion === input.promptVersion
  );
}

/** The role fields of a call, or nothing. A role without its prompt version (or the reverse) is refused before any write. */
function roleFieldsOf(input: CallInput): { role?: ClaudeRole; promptVersion?: string } {
  if ((input.role === undefined) !== (input.promptVersion === undefined)) {
    throw new EngineError("invalid_input", "a Claude call names its role and its prompt version together", {
      stage: input.stage,
    });
  }
  return input.role === undefined ? {} : { role: input.role, promptVersion: input.promptVersion };
}

/** What the reservation has committed so far: each entry's actual cost, or its hold until it is reconciled. */
export async function committedFor(store: LedgerStore, reservationId: string): Promise<number> {
  const rows = await store.listEntries(reservationId);
  return sumUsd(rows.map((row) => row.actualUsd ?? row.reservedUsd));
}

/**
 * Authorize one paid call before it is submitted.
 * - A key that was already used returns the existing entry (status duplicate) and changes nothing.
 * - A reservation that is not reserved (paused or released) refuses the call.
 * - In cap mode, a call that would take the reservation above its amount is refused.
 * - In warn mode the call is authorized with an overrun alert; in observe mode it is recorded silently. Both
 *   raise the reservation to the committed amount, so the monthly total stays right.
 */
export async function authorizeCall(store: LedgerStore, input: CallInput): Promise<AuthorizeResult> {
  const estimate = usdInput(input.estimateUsd, "estimateUsd");
  if (input.idempotencyKey.length === 0) {
    throw new EngineError("invalid_input", "a paid call needs an idempotency key");
  }
  const trace = roleFieldsOf(input);

  const existing = await store.getEntryByKey(input.idempotencyKey);
  if (existing) {
    return { status: "duplicate", entry: existing, samePayload: samePayload(existing, input) };
  }

  const reservation = await store.getReservation(input.reservationId);
  if (!reservation) {
    throw new EngineError("not_found", `reservation ${input.reservationId} does not exist`, { stage: input.stage });
  }
  if (reservation.state !== "reserved") {
    return {
      status: "refused",
      reason: `reservation ${reservation.reservationId} is ${reservation.state}; no call is made`,
      alerts: [],
    };
  }

  const committedUsd = await committedFor(store, reservation.reservationId);
  const projectedUsd = sumUsd([committedUsd, estimate]);
  const overrun = projectedUsd > reservation.reservedUsd;
  const message = `call ${input.stage} would take reservation ${reservation.reservationId} to ${projectedUsd} USD, above its ${reservation.reservedUsd} USD`;
  const alert: BudgetAlert = {
    kind: "overrun",
    scope: "call",
    limitUsd: reservation.reservedUsd,
    committedUsd: projectedUsd,
    message,
  };

  // The request budget and the month budget the reservation was authorized against (contract v6). The month's committed total is
  // the reservations' amounts, and this call raises this reservation's amount only by what is above it.
  const requestOver = reservation.requestBudgetUsd !== undefined && projectedUsd > reservation.requestBudgetUsd;
  const requestBeyond =
    reservation.requestBudgetUsd !== undefined && projectedUsd > (reservation.requestAllowanceUsd ?? reservation.requestBudgetUsd);
  const monthBudget = reservation.workspaceMonthBudgetUsd;
  const monthTotals = monthBudget === undefined ? null : await store.sumForMonth(reservation.workspaceId, reservation.createdAt.slice(0, 7));
  const monthProjectedUsd =
    monthTotals === null ? 0 : sumUsd([monthTotals.reservedUsd, Math.max(0, projectedUsd - reservation.reservedUsd)]);
  const monthOver = monthBudget !== undefined && monthProjectedUsd > monthBudget;
  const monthBeyond = monthBudget !== undefined && monthProjectedUsd > (reservation.workspaceMonthAllowanceUsd ?? monthBudget);
  const budgetAlerts: BudgetAlert[] = [];
  if (requestOver) {
    budgetAlerts.push({
      kind: "overrun",
      scope: "request",
      limitUsd: reservation.requestBudgetUsd ?? 0,
      committedUsd: projectedUsd,
      message: `call ${input.stage} would take the request to ${projectedUsd} USD, above its ${reservation.requestBudgetUsd} USD budget`,
    });
  }
  if (monthOver) {
    budgetAlerts.push({
      kind: "overrun",
      scope: "workspace_month",
      limitUsd: monthBudget ?? 0,
      committedUsd: monthProjectedUsd,
      message: `call ${input.stage} would take the workspace month to ${monthProjectedUsd} USD, above its ${monthBudget} USD budget`,
    });
  }

  // Cap mode refuses a call only past an allowance (owner direction 2026-10-23). Inside both allowances, a call that overruns its hold is
  // authorized and the hold is raised to what the call takes it to. Warn and observe record the overrun, as before.
  // A reservation that records no budget has no allowance to measure a call against. An overrun of its hold is then still refused in cap
  // mode, which fails closed; the tolerance applies to the reservations that carry their budgets.
  const allowanceKnown = reservation.requestBudgetUsd !== undefined || reservation.workspaceMonthBudgetUsd !== undefined;
  const beyondAllowance = requestBeyond || monthBeyond || (overrun && !allowanceKnown);
  const reasons = [...(overrun ? [message] : []), ...budgetAlerts.map((item) => item.message)];
  if (beyondAllowance && reservation.mode === "cap") {
    return { status: "refused", reason: reasons.join("; "), alerts: [...(overrun ? [alert] : []), ...budgetAlerts] };
  }
  if (overrun && reservation.mode === "cap") {
    await store.updateReservation(budgetReservationSchema.parse({ ...reservation, reservedUsd: projectedUsd }));
  }

  const row: LedgerRow = {
    entryId: input.entryId ?? newId("led_"),
    requestId: reservation.requestId,
    stage: input.stage,
    provider: input.provider,
    model: input.model,
    estimateUsd: estimate,
    reservedUsd: estimate,
    idempotencyKey: input.idempotencyKey,
    at: input.at,
    providerRef: null,
    ...trace,
    workspaceId: reservation.workspaceId,
    reservationId: reservation.reservationId,
  };
  const { workspaceId: _workspace, reservationId: _reservation, ...contractFields } = row;
  const checked = ledgerEntrySchema.safeParse(contractFields);
  if (!checked.success) {
    throw new EngineError("invalid_input", `ledger entry for ${input.stage} is invalid: ${checked.error.message}`, {
      stage: input.stage,
    });
  }

  const appended = await store.appendEntry(row);
  if (!appended.created) {
    return { status: "duplicate", entry: appended.entry, samePayload: samePayload(appended.entry, input) };
  }

  if (overrun) {
    await store.updateReservation({ ...reservation, reservedUsd: roundUsd(projectedUsd) });
  }
  return {
    status: "authorized",
    entry: appended.entry,
    alerts: reservation.mode === "warn" ? [...(overrun ? [alert] : []), ...budgetAlerts] : [],
  };
}
