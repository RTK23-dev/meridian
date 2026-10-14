// The budget's LedgerStore on engine_reservations and engine_ledger (Video Engine Bible 14; the budget README's Postgres note).
// The budget logic reads, then writes. Two things make that safe on Postgres:
// - withReservationLedger and withWorkspaceLedger run the whole budget call in one transaction under a row lock (the
//   reservation for authorize and reconcile, the workspace for reserve, which sums the month before it stores a new one).
// - the unique key (organization_id, idempotency_key) on engine_ledger makes a duplicate call return the stored entry.

import { EngineError, roundUsd, type BudgetReservation } from "../contracts/index.ts";
import type { AppendResult, LedgerRow, LedgerStore, MonthTotals } from "../budget/store.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { transaction } from "./orchestrator-sql.ts";

type ReservationRow = {
  id: string;
  organization_id: string;
  request_id: string;
  mode: BudgetReservation["mode"];
  state: BudgetReservation["state"];
  lines: string;
  estimate_usd: string | number;
  redo_allowance_usd: string | number;
  reserved_usd: string | number;
  paused_reason: string | null;
  created_at: unknown;
};

type LedgerDbRow = {
  id: string;
  organization_id: string;
  request_id: string;
  reservation_id: string;
  stage: string;
  provider: string;
  model: string;
  estimate_usd: string | number;
  reserved_usd: string | number;
  actual_usd: string | number | null;
  actual_is_estimate: boolean | null;
  idempotency_key: string;
  at: unknown;
};

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function rowToReservation(row: ReservationRow): BudgetReservation {
  const reservation: BudgetReservation = {
    schema: "meridian.budget_reservation/v1",
    reservationId: row.id,
    requestId: row.request_id,
    workspaceId: row.organization_id,
    mode: row.mode,
    lines: JSON.parse(row.lines) as BudgetReservation["lines"],
    estimateUsd: Number(row.estimate_usd),
    redoAllowanceUsd: Number(row.redo_allowance_usd),
    reservedUsd: Number(row.reserved_usd),
    state: row.state,
    createdAt: toIso(row.created_at),
  };
  if (row.paused_reason !== null) reservation.pausedReason = row.paused_reason;
  return reservation;
}

function rowToLedger(row: LedgerDbRow): LedgerRow {
  const entry: LedgerRow = {
    entryId: row.id,
    requestId: row.request_id,
    stage: row.stage,
    provider: row.provider,
    model: row.model,
    estimateUsd: Number(row.estimate_usd),
    reservedUsd: Number(row.reserved_usd),
    idempotencyKey: row.idempotency_key,
    at: toIso(row.at),
    workspaceId: row.organization_id,
    reservationId: row.reservation_id,
  };
  if (row.actual_usd !== null) entry.actualUsd = Number(row.actual_usd);
  if (row.actual_is_estimate !== null) entry.actualIsEstimate = row.actual_is_estimate;
  return entry;
}

function isUniqueViolation(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === "23505";
}

function refuseOtherWorkspace(organizationId: string, workspaceId: string): void {
  if (workspaceId !== organizationId) {
    throw new EngineError("invalid_input", "a ledger row belongs to another workspace and was not written");
  }
}

/** A LedgerStore for one workspace. Every query is scoped to it. Use inside withReservationLedger or withWorkspaceLedger. */
export function sqlLedgerStore(sql: Sql, organizationId: string): LedgerStore {
  const getReservation = async (reservationId: string): Promise<BudgetReservation | null> => {
    const rows = await sql<ReservationRow>`
      select id, organization_id, request_id, mode, state, lines, estimate_usd, redo_allowance_usd, reserved_usd, paused_reason, created_at
      from engine_reservations where id = ${reservationId} and organization_id = ${organizationId} limit 1
    `;
    return rows[0] ? rowToReservation(rows[0]) : null;
  };

  const getEntryByKey = async (idempotencyKey: string): Promise<LedgerRow | null> => {
    const rows = await sql<LedgerDbRow>`
      select id, organization_id, request_id, reservation_id, stage, provider, model, estimate_usd, reserved_usd,
        actual_usd, actual_is_estimate, idempotency_key, at
      from engine_ledger where organization_id = ${organizationId} and idempotency_key = ${idempotencyKey} limit 1
    `;
    return rows[0] ? rowToLedger(rows[0]) : null;
  };

  return {
    async createReservation(reservation) {
      refuseOtherWorkspace(organizationId, reservation.workspaceId);
      try {
        const inserted = await sql<{ id: string }>`
          insert into engine_reservations (id, organization_id, request_id, mode, state, lines, estimate_usd, redo_allowance_usd,
            reserved_usd, paused_reason, created_at)
          values (${reservation.reservationId}, ${organizationId}, ${reservation.requestId}, ${reservation.mode}, ${reservation.state},
            ${JSON.stringify(reservation.lines)}, ${reservation.estimateUsd}, ${reservation.redoAllowanceUsd}, ${reservation.reservedUsd},
            ${reservation.pausedReason ?? null}, ${reservation.createdAt})
          on conflict (id) do nothing
          returning id
        `;
        if (inserted.length === 0) throw new EngineError("conflict", `reservation ${reservation.reservationId} already exists`);
      } catch (error) {
        if (isUniqueViolation(error)) throw new EngineError("conflict", `reservation ${reservation.reservationId} already exists`, { cause: error });
        throw error;
      }
    },

    getReservation,

    async updateReservation(reservation) {
      refuseOtherWorkspace(organizationId, reservation.workspaceId);
      const updated = await sql<{ id: string }>`
        update engine_reservations
        set state = ${reservation.state}, lines = ${JSON.stringify(reservation.lines)}, estimate_usd = ${reservation.estimateUsd},
          redo_allowance_usd = ${reservation.redoAllowanceUsd}, reserved_usd = ${reservation.reservedUsd},
          paused_reason = ${reservation.pausedReason ?? null}
        where id = ${reservation.reservationId} and organization_id = ${organizationId}
        returning id
      `;
      if (updated.length === 0) throw new EngineError("not_found", `reservation ${reservation.reservationId} does not exist`);
    },

    async appendEntry(row): Promise<AppendResult> {
      refuseOtherWorkspace(organizationId, row.workspaceId);
      try {
        const inserted = await sql<{ id: string }>`
          insert into engine_ledger (id, organization_id, request_id, reservation_id, stage, provider, model, estimate_usd, reserved_usd,
            actual_usd, actual_is_estimate, idempotency_key, at)
          values (${row.entryId}, ${organizationId}, ${row.requestId}, ${row.reservationId}, ${row.stage}, ${row.provider}, ${row.model},
            ${row.estimateUsd}, ${row.reservedUsd}, ${row.actualUsd ?? null}, ${row.actualIsEstimate ?? null}, ${row.idempotencyKey}, ${row.at})
          on conflict (organization_id, idempotency_key) do nothing
          returning id
        `;
        if (inserted.length > 0) return { entry: { ...row, workspaceId: organizationId }, created: true };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        throw new EngineError("conflict", `ledger entry ${row.entryId} already exists under another key`, { cause: error });
      }
      const existing = await getEntryByKey(row.idempotencyKey);
      if (!existing) throw new EngineError("internal", `ledger key ${row.idempotencyKey} conflicted but no entry was found`);
      return { entry: existing, created: false };
    },

    getEntryByKey,

    async listEntries(reservationId) {
      const rows = await sql<LedgerDbRow>`
        select id, organization_id, request_id, reservation_id, stage, provider, model, estimate_usd, reserved_usd,
          actual_usd, actual_is_estimate, idempotency_key, at
        from engine_ledger where organization_id = ${organizationId} and reservation_id = ${reservationId}
        order by at asc, id asc
      `;
      return rows.map(rowToLedger);
    },

    async setActual(entryId, actual) {
      const rows = await sql<LedgerDbRow>`
        update engine_ledger set actual_usd = ${actual.actualUsd}, actual_is_estimate = ${actual.actualIsEstimate}
        where id = ${entryId} and organization_id = ${organizationId}
        returning id, organization_id, request_id, reservation_id, stage, provider, model, estimate_usd, reserved_usd,
          actual_usd, actual_is_estimate, idempotency_key, at
      `;
      if (!rows[0]) throw new EngineError("not_found", `ledger entry ${entryId} does not exist`);
      return rowToLedger(rows[0]);
    },

    async sumForMonth(workspaceId, month): Promise<MonthTotals> {
      refuseOtherWorkspace(organizationId, workspaceId);
      const reserved = await sql<{ total: string | number }>`
        select coalesce(sum(reserved_usd), 0) as total from engine_reservations
        where organization_id = ${organizationId} and state <> 'paused'
          and to_char(created_at at time zone 'UTC', 'YYYY-MM') = ${month}
      `;
      const actual = await sql<{ total: string | number }>`
        select coalesce(sum(actual_usd), 0) as total from engine_ledger
        where organization_id = ${organizationId} and to_char(at at time zone 'UTC', 'YYYY-MM') = ${month}
      `;
      return { reservedUsd: roundUsd(Number(reserved[0]?.total ?? 0)), actualUsd: roundUsd(Number(actual[0]?.total ?? 0)) };
    },
  };
}

/** Runs one budget call under a lock on its reservation: authorize, reconcile and release. */
export async function withReservationLedger<T>(sql: Sql, organizationId: string, reservationId: string, fn: (store: LedgerStore) => Promise<T>): Promise<T> {
  return transaction(sql, async (tx) => {
    const locked = await tx<{ id: string }>`
      select id from engine_reservations where id = ${reservationId} and organization_id = ${organizationId} for update
    `;
    if (!locked[0]) throw new EngineError("not_found", `reservation ${reservationId} does not exist`);
    return fn(sqlLedgerStore(tx, organizationId));
  });
}

/** Runs a reserve call under a lock on the workspace, so two reservations cannot both pass the monthly check. */
export async function withWorkspaceLedger<T>(sql: Sql, organizationId: string, fn: (store: LedgerStore) => Promise<T>): Promise<T> {
  return transaction(sql, async (tx) => {
    const locked = await tx<{ id: string }>`select id from organizations where id = ${organizationId} for update`;
    if (!locked[0]) throw new EngineError("not_found", `workspace ${organizationId} does not exist`);
    return fn(sqlLedgerStore(tx, organizationId));
  });
}
