// The ledger's storage interface (Bible 5.4, 14) and an in-memory implementation for tests. The budget logic in
// this folder is written against LedgerStore only. eng-pipeline implements it on the engine_ledger table.

import { EngineError, sumUsd, type BudgetReservation, type LedgerEntry, type LedgerSettlement } from "../contracts/index.ts";

/** A ledger entry with the storage context the contract does not carry: the workspace and the reservation. */
export type LedgerRow = LedgerEntry & {
  workspaceId: string;
  reservationId: string;
};

export type AppendResult = { entry: LedgerRow; created: boolean };

/** Reserved and actual totals for one workspace month ("YYYY-MM"). */
export type MonthTotals = { reservedUsd: number; actualUsd: number };

export interface LedgerStore {
  /** Store a new reservation. Throws a conflict error if the id already exists. */
  createReservation(reservation: BudgetReservation): Promise<void>;
  getReservation(reservationId: string): Promise<BudgetReservation | null>;
  /** Replace an existing reservation. Throws not_found if it does not exist. */
  updateReservation(reservation: BudgetReservation): Promise<void>;
  /**
   * Append an entry. Atomic on the idempotency key: when the key already exists, return the existing entry with
   * created false and change nothing. This is what stops a call from being billed twice.
   */
  appendEntry(row: LedgerRow): Promise<AppendResult>;
  getEntryByKey(idempotencyKey: string): Promise<LedgerRow | null>;
  listEntries(reservationId: string): Promise<LedgerRow[]>;
  /**
   * Settle an entry: record its actual cost and how it was obtained (a verified bill, or a confirmed absence, which is 0). An estimate
   * is never passed here. Throws not_found if the entry does not exist, and conflict if it is already settled.
   */
  settle(entryId: string, settlement: { actualUsd: number; settlement: LedgerSettlement }): Promise<LedgerRow>;
  /**
   * Reserved total: the reservedUsd of the workspace's reservations created in the month, excluding paused ones.
   * Actual total: the actuals of the workspace's entries that happened in the month.
   */
  sumForMonth(workspaceId: string, month: string): Promise<MonthTotals>;
}

/** In-memory LedgerStore. Values are copied in and out, so callers cannot change stored state by accident. */
export function memoryLedgerStore(): LedgerStore {
  const reservations = new Map<string, BudgetReservation>();
  const rows: LedgerRow[] = [];
  const rowByKey = new Map<string, LedgerRow>();

  const copy = <T>(value: T): T => structuredClone(value);

  return {
    async createReservation(reservation) {
      if (reservations.has(reservation.reservationId)) {
        throw new EngineError("conflict", `reservation ${reservation.reservationId} already exists`);
      }
      reservations.set(reservation.reservationId, copy(reservation));
    },

    async getReservation(reservationId) {
      const found = reservations.get(reservationId);
      return found ? copy(found) : null;
    },

    async updateReservation(reservation) {
      if (!reservations.has(reservation.reservationId)) {
        throw new EngineError("not_found", `reservation ${reservation.reservationId} does not exist`);
      }
      reservations.set(reservation.reservationId, copy(reservation));
    },

    async appendEntry(row) {
      const existing = rowByKey.get(row.idempotencyKey);
      if (existing) {
        return { entry: copy(existing), created: false };
      }
      const stored = copy(row);
      rows.push(stored);
      rowByKey.set(stored.idempotencyKey, stored);
      return { entry: copy(stored), created: true };
    },

    async getEntryByKey(idempotencyKey) {
      const found = rowByKey.get(idempotencyKey);
      return found ? copy(found) : null;
    },

    async listEntries(reservationId) {
      return rows.filter((row) => row.reservationId === reservationId).map(copy);
    },

    async settle(entryId, settlement) {
      const row = rows.find((candidate) => candidate.entryId === entryId);
      if (!row) {
        throw new EngineError("not_found", `ledger entry ${entryId} does not exist`);
      }
      if (row.settlement !== undefined) {
        throw new EngineError("conflict", `ledger entry ${entryId} is already settled`);
      }
      row.actualUsd = settlement.actualUsd;
      row.settlement = settlement.settlement;
      return copy(row);
    },

    async sumForMonth(workspaceId, month) {
      const reserved = [...reservations.values()].filter(
        (reservation) =>
          reservation.workspaceId === workspaceId &&
          reservation.createdAt.startsWith(month) &&
          reservation.state !== "paused",
      );
      const actual = rows.filter((row) => row.workspaceId === workspaceId && row.at.startsWith(month));
      return {
        reservedUsd: sumUsd(reserved.map((reservation) => reservation.reservedUsd)),
        actualUsd: sumUsd(actual.map((row) => row.actualUsd ?? 0)),
      };
    },
  };
}
