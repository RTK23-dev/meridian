// Reserve before any paid call (Bible 14.1 steps 2 and 3). A budget is a line (owner direction 2026-10-23, decision D12). Two committed
// totals are read against their budgets: the request's (every reservation of the request, so a remake sees the earlier spend) and the
// workspace month's. A reservation is always accepted: a plan above a budget is held with a note, never paused (D17). A paid call starts
// only while both committed totals are below their budgets and its own hold fits under both (D17). Each paid call is authorized against
// its reservation first, and a duplicate key never bills twice.

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
import { positionOfLine, startsBelowLine } from "./line.ts";
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

/**
 * The note that committed spend would be above a budget (D12). It is a note, never a refusal: calls start only while their line is below
 * the budget.
 */
export function overBudgetNote(scope: "request" | "workspace_month", committedUsd: number, budgetUsd: number): BudgetAlert {
  const subject = scope === "request" ? "the request" : "the workspace month";
  return {
    kind: "overrun",
    scope,
    limitUsd: budgetUsd,
    committedUsd,
    message: `${subject} would commit ${committedUsd} USD, above its ${budgetUsd} USD budget; calls start only while the committed spend is below the budget`,
  };
}

/** The committed spend a hold is read against, before the hold makes any call (D12). */
export type HoldLines = {
  requestCommittedUsd: number;
  requestBudgetUsd: number;
  monthCommittedUsd: number;
  workspaceMonthBudgetUsd: number;
  /** The spend the hold still adds: the plan, less what its own reservation has already committed. */
  plannedUsd: number;
};

/** The notes of a hold (D12): one for each budget its committed spend, with the planned spend, would be above. A note, never a refusal. */
export function holdNotes(lines: HoldLines): BudgetAlert[] {
  const alerts: BudgetAlert[] = [];
  const requestCommittedUsd = sumUsd([lines.requestCommittedUsd, lines.plannedUsd]);
  if (requestCommittedUsd > lines.requestBudgetUsd) {
    alerts.push(overBudgetNote("request", requestCommittedUsd, lines.requestBudgetUsd));
  }
  const monthCommittedUsd = sumUsd([lines.monthCommittedUsd, lines.plannedUsd]);
  if (monthCommittedUsd > lines.workspaceMonthBudgetUsd) {
    alerts.push(overBudgetNote("workspace_month", monthCommittedUsd, lines.workspaceMonthBudgetUsd));
  }
  return alerts;
}

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
};

export type ReserveResult = {
  reservation: BudgetReservation;
  alerts: BudgetAlert[];
  /** False when the reservation already existed and nothing new was stored. */
  created: boolean;
};

/**
 * Reserve the plan's estimate against the request budget and the workspace month (D12). A reservation is always accepted, and so is a plan
 * above a budget: it is held with a note, not refused or paused, and its paid calls are gated one by one (authorizeCall, D17).
 * - cap: reserved, with a note for each budget the hold is above.
 * - warn: reserved, and the notes are returned.
 * - observe: reserved and recorded; no note.
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
  const monthCommittedUsd = await store.committedForMonth(input.workspaceId, input.now.slice(0, 7));
  const requestCommittedUsd = await store.committedForRequest(input.requestId);
  const alerts = holdNotes({
    requestCommittedUsd,
    requestBudgetUsd: input.requestBudgetUsd,
    monthCommittedUsd,
    workspaceMonthBudgetUsd: input.workspaceMonthBudgetUsd,
    plannedUsd: reservedUsd,
  });

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
    state: "reserved",
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
 * Authorize one paid call before it is submitted (owner direction 2026-10-23: D12, a budget is a line; D17, a paid call starts only if its
 * own hold fits the line).
 * - A key that was already used returns the existing entry (status duplicate) and changes nothing.
 * - A reservation that is paused or released refuses the call. An exceeded one is decided by its lines, below.
 * - In cap mode a call starts only if, before the call, the request's committed spend (every reservation of the request) is below its
 *   request budget and the workspace month's committed spend is below its month budget, and if the call's hold fits under each: the
 *   committed spend before the call plus the call's estimate is not above the budget. A call at a line is refused even with a zero
 *   estimate, and a refused call holds nothing. A call that starts may take this reservation above its hold: the hold is raised to what
 *   the call takes it to, and the overrun of the hold is returned as an alert. A bill above its estimate can still take a line; the next
 *   call is then refused.
 * - A reservation that records no budget has no line to measure a call against. In cap mode an overrun of its hold is refused instead
 *   (fail closed).
 * - In warn mode the call is authorized with its alerts, including the overshoot of a budget; in observe mode it is recorded silently.
 *   Both raise the reservation to the committed amount, so the monthly total stays right.
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
  if (reservation.state !== "reserved" && reservation.state !== "exceeded") {
    return {
      status: "refused",
      reason: `reservation ${reservation.reservationId} is ${reservation.state}; no call is made`,
      alerts: [],
    };
  }

  // This reservation's hold: its committed spend with this call, against the amount the hold holds.
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

  // The two lines, read before this call (D12). The request's committed spend counts every reservation of the request. The month's
  // committed spend counts the calls that happen in the month of this call, as the ledger dates them.
  const requestBudget = reservation.requestBudgetUsd;
  const monthBudget = reservation.workspaceMonthBudgetUsd;
  const requestCommittedUsd = await store.committedForRequest(reservation.requestId);
  const monthCommittedUsd = monthBudget === undefined ? 0 : await store.committedForMonth(reservation.workspaceId, input.at.slice(0, 7));
  // The overshoot of a budget this call would take: the note of a refusal, or of a warn-mode call. A cap-mode call that starts fits under
  // both budgets (D17), so it has none.
  const budgetAlerts: BudgetAlert[] = [];
  const requestProjectedUsd = sumUsd([requestCommittedUsd, estimate]);
  if (requestBudget !== undefined && requestProjectedUsd > requestBudget) {
    budgetAlerts.push({
      kind: "overrun",
      scope: "request",
      limitUsd: requestBudget,
      committedUsd: requestProjectedUsd,
      message: `call ${input.stage} would take the request to ${requestProjectedUsd} USD, above its ${requestBudget} USD budget`,
    });
  }
  const monthProjectedUsd = sumUsd([monthCommittedUsd, estimate]);
  if (monthBudget !== undefined && monthProjectedUsd > monthBudget) {
    budgetAlerts.push({
      kind: "overrun",
      scope: "workspace_month",
      limitUsd: monthBudget,
      committedUsd: monthProjectedUsd,
      message: `call ${input.stage} would take the workspace month to ${monthProjectedUsd} USD, above its ${monthBudget} USD budget`,
    });
  }

  // Cap mode refuses a call at a line, when its own hold does not fit under a line (D17), or for a reservation with no budget to measure
  // against (fail closed). One reason for each budget: the line it is at, or else the hold that would take it past.
  const budgetKnown = requestBudget !== undefined || monthBudget !== undefined;
  const reasons: string[] = [];
  if (requestBudget !== undefined) {
    if (!startsBelowLine(requestCommittedUsd, requestBudget)) {
      reasons.push(`the request has committed ${requestCommittedUsd} USD, at or above its ${requestBudget} USD budget, so no paid call starts`);
    } else if (positionOfLine(requestProjectedUsd, requestBudget) === "over_budget") {
      reasons.push(`call ${input.stage} would take the request to ${requestProjectedUsd} USD, above its ${requestBudget} USD budget, so it does not start`);
    }
  }
  if (monthBudget !== undefined) {
    if (!startsBelowLine(monthCommittedUsd, monthBudget)) {
      reasons.push(`the workspace month has committed ${monthCommittedUsd} USD, at or above its ${monthBudget} USD budget, so no paid call starts`);
    } else if (positionOfLine(monthProjectedUsd, monthBudget) === "over_budget") {
      reasons.push(`call ${input.stage} would take the workspace month to ${monthProjectedUsd} USD, above its ${monthBudget} USD budget, so it does not start`);
    }
  }
  if (overrun && !budgetKnown) {
    reasons.push(`${message}, and the reservation records no budget to measure the call against`);
  }
  if (reasons.length > 0 && reservation.mode === "cap") {
    return { status: "refused", reason: reasons.join("; "), alerts: [...(overrun ? [alert] : []), ...budgetAlerts] };
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
    alerts: reservation.mode === "observe" ? [] : [...(overrun ? [alert] : []), ...budgetAlerts],
  };
}
