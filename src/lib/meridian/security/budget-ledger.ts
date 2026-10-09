/**
 * Durable Budget Reservation Ledger
 *
 * Implements Section P0.4 of Hardening / Release-Blocker Fixes:
 * - Integer micro-units (1 USD = 1,000,000 micros) eliminating floating-point math drift
 * - Atomic conditional reservation (prevents concurrency overspend race conditions)
 * - Two-phase reservation lifecycle: RESERVE -> ACTUAL USAGE -> RECONCILE / RELEASE
 * - Strict bounds checking (rejects NaN, Infinity, negative, null, exorbitant caps)
 */

import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";

export const MICROS_PER_USD = 1_000_000n;
export const MAX_SAFE_CAP_USD = 100_000;

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class InvalidBudgetCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBudgetCapError";
  }
}

export function toMicros(usd: number): bigint {
  if (typeof usd !== "number" || !Number.isFinite(usd) || Number.isNaN(usd) || usd < 0) {
    throw new InvalidBudgetCapError(`Invalid USD amount: ${usd}`);
  }
  return BigInt(Math.round(usd * 1_000_000));
}

export function toUsd(micros: bigint): number {
  return Number(micros) / 1_000_000;
}

export function validateCap(capUsd: number): bigint {
  if (
    typeof capUsd !== "number" ||
    Number.isNaN(capUsd) ||
    !Number.isFinite(capUsd) ||
    capUsd < 0 ||
    capUsd > MAX_SAFE_CAP_USD
  ) {
    throw new InvalidBudgetCapError(
      `Budget cap must be a finite non-negative number <= ${MAX_SAFE_CAP_USD}, got: ${capUsd}`
    );
  }
  return toMicros(capUsd);
}

/** Typed SQL row shapes — used only inside BudgetLedgerService queries. */
interface AccountRow {
  id: string;
  organization_id: string;
  brand_id: string;
  max_spend_micros: string | number | bigint;
  spent_micros: string | number | bigint;
  reserved_micros: string | number | bigint;
  created_at: string;
  updated_at: string;
}

interface ReservationRow {
  id: string;
  organization_id: string;
  brand_id: string;
  account_id: string;
  creative_plan_id: string | null;
  production_job_id: string | null;
  amount_micros: string | number | bigint;
  status: "RESERVED" | "PARTIALLY_USED" | "RELEASED" | "RECONCILED" | "FAILED" | "EXPIRED";
  created_at: string;
  expires_at: string;
  released_at?: string;
  reconciled_at?: string;
}

interface BalanceRow {
  id: string;
  spent_micros: string | number | bigint;
  reserved_micros: string | number | bigint;
  max_spend_micros?: string | number | bigint;
}

interface CapRow {
  max_spend_micros: string | number | bigint;
  spent_micros: string | number | bigint;
  reserved_micros: string | number | bigint;
}

export interface BudgetAccount {
  id: string;
  organizationId: string;
  brandId: string;
  maxSpendMicros: bigint;
  spentMicros: bigint;
  reservedMicros: bigint;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetReservation {
  id: string;
  organizationId: string;
  brandId: string;
  accountId: string;
  creativePlanId?: string;
  productionJobId?: string;
  amountMicros: bigint;
  status: "RESERVED" | "PARTIALLY_USED" | "RELEASED" | "RECONCILED" | "FAILED" | "EXPIRED";
  createdAt: string;
  expiresAt: string;
  releasedAt?: string;
  reconciledAt?: string;
}

export class BudgetLedgerService {
  /**
   * Ensures a budget account exists for the tenant, optionally updating the spend cap.
   */
  static async getOrCreateAccount(
    sql: Sql,
    organizationId: string,
    brandId: string,
    initialCapUsd = 100.0
  ): Promise<BudgetAccount> {
    const capMicros = validateCap(initialCapUsd);
    const existing = await sql<AccountRow>`
      select id, organization_id, brand_id, max_spend_micros, spent_micros, reserved_micros, created_at, updated_at
      from budget_accounts
      where organization_id = ${organizationId} and brand_id = ${brandId}
      limit 1
    `;

    if (existing.length > 0) {
      const row = existing[0];
      return {
        id: row.id,
        organizationId: row.organization_id,
        brandId: row.brand_id,
        maxSpendMicros: BigInt(row.max_spend_micros),
        spentMicros: BigInt(row.spent_micros),
        reservedMicros: BigInt(row.reserved_micros),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }

    const id = randomUUID();
    const rows = await sql<AccountRow>`
      insert into budget_accounts (id, organization_id, brand_id, max_spend_micros, spent_micros, reserved_micros)
      values (${id}, ${organizationId}, ${brandId}, ${capMicros.toString()}, 0, 0)
      on conflict (organization_id, brand_id) do update
        set updated_at = now()
      returning id, organization_id, brand_id, max_spend_micros, spent_micros, reserved_micros, created_at, updated_at
    `;

    const row = rows[0];
    return {
      id: row.id,
      organizationId: row.organization_id,
      brandId: row.brand_id,
      maxSpendMicros: BigInt(row.max_spend_micros),
      spentMicros: BigInt(row.spent_micros),
      reservedMicros: BigInt(row.reserved_micros),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Atomically reserve budget funds using conditional DB update.
   * Invariant: spent_micros + reserved_micros + amountMicros <= max_spend_micros
   */
  static async reserve(
    sql: Sql,
    params: {
      organizationId: string;
      brandId: string;
      amountMicros: bigint;
      creativePlanId?: string;
      productionJobId?: string;
    }
  ): Promise<BudgetReservation> {
    if (params.amountMicros <= 0n) {
      throw new InvalidBudgetCapError(`Reservation amount must be positive, got: ${params.amountMicros}`);
    }

    const account = await this.getOrCreateAccount(sql, params.organizationId, params.brandId);

    // Atomic conditional update
    const updatedAccounts = await sql<BalanceRow>`
      update budget_accounts
      set reserved_micros = reserved_micros + ${params.amountMicros.toString()}::bigint,
          updated_at = now()
      where id = ${account.id}
        and (spent_micros + reserved_micros + ${params.amountMicros.toString()}::bigint) <= max_spend_micros
      returning id, max_spend_micros, spent_micros, reserved_micros
    `;

    if (updatedAccounts.length === 0) {
      // Check current balances to provide helpful error
      const current = await sql<CapRow>`
        select max_spend_micros, spent_micros, reserved_micros
        from budget_accounts where id = ${account.id}
      `;
      const cur = current[0];
      const maxUsd = toUsd(BigInt(cur?.max_spend_micros || 0));
      const remainingUsd = toUsd(
        BigInt(cur?.max_spend_micros || 0) - (BigInt(cur?.spent_micros || 0) + BigInt(cur?.reserved_micros || 0))
      );
      throw new BudgetExceededError(
        `Budget limit exceeded. Requested: $${toUsd(params.amountMicros).toFixed(2)}, Available: $${Math.max(0, remainingUsd).toFixed(2)} (Cap: $${maxUsd.toFixed(2)})`
      );
    }

    const reservationId = randomUUID();
    const resRows = await sql<ReservationRow>`
      insert into budget_reservations (
        id, organization_id, brand_id, account_id, creative_plan_id, production_job_id, amount_micros, status
      ) values (
        ${reservationId}, ${params.organizationId}, ${params.brandId}, ${account.id},
        ${params.creativePlanId || null}, ${params.productionJobId || null},
        ${params.amountMicros.toString()}::bigint, 'RESERVED'
      )
      returning id, organization_id, brand_id, account_id, creative_plan_id, production_job_id, amount_micros, status, created_at, expires_at
    `;

    const res = resRows[0];
    const updatedAcc = updatedAccounts[0];

    // Double-entry ledger audit
    await sql`
      insert into budget_ledger_entries (
        id, organization_id, brand_id, account_id, reservation_id, entry_type,
        delta_spent_micros, delta_reserved_micros, balance_spent_micros, balance_reserved_micros, metadata
      ) values (
        ${randomUUID()}, ${params.organizationId}, ${params.brandId}, ${account.id}, ${reservationId},
        'RESERVATION_CREATED', 0, ${params.amountMicros.toString()}::bigint,
        ${updatedAcc.spent_micros}, ${updatedAcc.reserved_micros},
        ${JSON.stringify({ creativePlanId: params.creativePlanId, productionJobId: params.productionJobId })}
      )
    `;

    return {
      id: res.id,
      organizationId: res.organization_id,
      brandId: res.brand_id,
      accountId: res.account_id,
      creativePlanId: res.creative_plan_id ?? undefined,
      productionJobId: res.production_job_id ?? undefined,
      amountMicros: BigInt(res.amount_micros),
      status: res.status,
      createdAt: res.created_at,
      expiresAt: res.expires_at,
    };
  }

  /**
   * Reconciles a reservation with actual provider spend.
   * Releases unused reservation funds back to available budget.
   */
  static async reconcile(
    sql: Sql,
    params: {
      reservationId: string;
      actualSpentMicros: bigint;
    }
  ): Promise<{ reservation: BudgetReservation; unusedReleasedMicros: bigint }> {
    const reservations = await sql<ReservationRow>`
      select id, organization_id, brand_id, account_id, amount_micros, status, created_at, expires_at
      from budget_reservations
      where id = ${params.reservationId} and status = 'RESERVED'
      limit 1
    `;

    if (reservations.length === 0) {
      throw new Error(`Reservation '${params.reservationId}' not found or already reconciled/released.`);
    }

    const res = reservations[0];
    const reservedMicros = BigInt(res.amount_micros);
    const actualSpentMicros = params.actualSpentMicros;
    const unusedReleasedMicros = reservedMicros > actualSpentMicros ? reservedMicros - actualSpentMicros : 0n;

    // Update account balances atomically:
    // spent += actualSpentMicros
    // reserved -= reservedMicros
    const updatedAccounts = await sql<BalanceRow>`
      update budget_accounts
      set spent_micros = spent_micros + ${actualSpentMicros.toString()}::bigint,
          reserved_micros = reserved_micros - ${reservedMicros.toString()}::bigint,
          updated_at = now()
      where id = ${res.account_id}
      returning id, spent_micros, reserved_micros
    `;

    const updatedAcc = updatedAccounts[0];

    // Mark reservation RECONCILED
    await sql`
      update budget_reservations
      set status = 'RECONCILED',
          reconciled_at = now()
      where id = ${res.id}
    `;

    // Audit in ledger
    await sql`
      insert into budget_ledger_entries (
        id, organization_id, brand_id, account_id, reservation_id, entry_type,
        delta_spent_micros, delta_reserved_micros, balance_spent_micros, balance_reserved_micros, metadata
      ) values (
        ${randomUUID()}, ${res.organization_id}, ${res.brand_id}, ${res.account_id}, ${res.id},
        'RESERVATION_RECONCILED',
        ${actualSpentMicros.toString()}::bigint,
        -${reservedMicros.toString()}::bigint,
        ${updatedAcc.spent_micros}, ${updatedAcc.reserved_micros},
        ${JSON.stringify({ actualSpentMicros: actualSpentMicros.toString(), unusedReleasedMicros: unusedReleasedMicros.toString() })}
      )
    `;

    return {
      reservation: {
        id: res.id,
        organizationId: res.organization_id,
        brandId: res.brand_id,
        accountId: res.account_id,
        amountMicros: reservedMicros,
        status: "RECONCILED",
        createdAt: res.created_at,
        expiresAt: res.expires_at,
      },
      unusedReleasedMicros,
    };
  }

  /**
   * Releases an unspent reservation completely (e.g. on provider error or cancellation).
   */
  static async release(
    sql: Sql,
    params: {
      reservationId: string;
      reason: string;
    }
  ): Promise<boolean> {
    const reservations = await sql<ReservationRow>`
      select id, organization_id, brand_id, account_id, amount_micros, status, created_at, expires_at
      from budget_reservations
      where id = ${params.reservationId} and status = 'RESERVED'
      limit 1
    `;

    if (reservations.length === 0) {
      return false; // Already finalized or doesn't exist
    }

    const res = reservations[0];
    const reservedMicros = BigInt(res.amount_micros);

    const updatedAccounts = await sql<BalanceRow>`
      update budget_accounts
      set reserved_micros = reserved_micros - ${reservedMicros.toString()}::bigint,
          updated_at = now()
      where id = ${res.account_id}
      returning id, spent_micros, reserved_micros
    `;

    const updatedAcc = updatedAccounts[0];

    await sql`
      update budget_reservations
      set status = 'RELEASED',
          released_at = now()
      where id = ${res.id}
    `;

    await sql`
      insert into budget_ledger_entries (
        id, organization_id, brand_id, account_id, reservation_id, entry_type,
        delta_spent_micros, delta_reserved_micros, balance_spent_micros, balance_reserved_micros, metadata
      ) values (
        ${randomUUID()}, ${res.organization_id}, ${res.brand_id}, ${res.account_id}, ${res.id},
        'RESERVATION_RELEASED',
        0,
        -${reservedMicros.toString()}::bigint,
        ${updatedAcc.spent_micros}, ${updatedAcc.reserved_micros},
        ${JSON.stringify({ reason: params.reason })}
      )
    `;

    return true;
  }
}
