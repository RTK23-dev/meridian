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
  actual_spent_micros?: string | number | bigint | null;
  estimated_spent_micros?: string | number | bigint | null;
  settled_spend_micros?: string | number | bigint | null;
  cost_basis?: "PROVIDER_ACTUAL" | "ESTIMATED" | "LEGACY_UNVERIFIED" | null;
}

export type CostObservation =
  | { basis: "PROVIDER_ACTUAL"; amountMicros: bigint }
  | { basis: "ESTIMATED"; amountMicros: bigint; estimatorVersion: string }
  | { basis: "UNKNOWN" };

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

    const reservationId = randomUUID();
    const resRows = await sql<ReservationRow>`
      with updated_account as (
        update budget_accounts
        set reserved_micros = reserved_micros + ${params.amountMicros.toString()}::bigint,
            updated_at = now()
        where id = ${account.id}
          and status = 'ACTIVE'
          and (spent_micros + reserved_micros + ${params.amountMicros.toString()}::bigint) <= max_spend_micros
        returning id, spent_micros, reserved_micros
      ), inserted_reservation as (
        insert into budget_reservations (
          id, organization_id, brand_id, account_id, creative_plan_id, production_job_id, amount_micros, status
        )
        select ${reservationId}, ${params.organizationId}, ${params.brandId}, updated_account.id,
          ${params.creativePlanId || null}, ${params.productionJobId || null}, ${params.amountMicros.toString()}::bigint, 'RESERVED'
        from updated_account
        returning id, organization_id, brand_id, account_id, creative_plan_id, production_job_id, amount_micros, status, created_at, expires_at
      ), inserted_ledger as (
        insert into budget_ledger_entries (
          id, organization_id, brand_id, account_id, reservation_id, entry_type,
          delta_spent_micros, delta_reserved_micros, balance_spent_micros, balance_reserved_micros, metadata
        )
        select ${randomUUID()}, r.organization_id, r.brand_id, r.account_id, r.id, 'RESERVATION_CREATED',
          0, ${params.amountMicros.toString()}::bigint, a.spent_micros, a.reserved_micros,
          ${JSON.stringify({ creativePlanId: params.creativePlanId, productionJobId: params.productionJobId })}::jsonb
        from inserted_reservation r join updated_account a on a.id = r.account_id
        returning id
      )
      select r.* from inserted_reservation r
    `;

    if (resRows.length === 0) {
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

    const res = resRows[0];

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
      actualSpentMicros?: bigint;
      cost?: CostObservation;
    }
  ): Promise<{ reservation: BudgetReservation; unusedReleasedMicros: bigint; overageMicros: bigint; alreadyReconciled: boolean }> {
    const cost: CostObservation = params.cost ?? { basis: "PROVIDER_ACTUAL", amountMicros: params.actualSpentMicros ?? -1n };
    if (cost.basis === "UNKNOWN") throw new InvalidBudgetCapError("Unknown provider cost cannot be settled; the reservation remains held for reconciliation.");
    if (cost.amountMicros < 0n) throw new InvalidBudgetCapError("Observed cost cannot be negative.");
    const settlementMicros = cost.amountMicros;
    const actualSpentMicros = cost.basis === "PROVIDER_ACTUAL" ? cost.amountMicros : null;
    const estimatedSpentMicros = cost.basis === "ESTIMATED" ? cost.amountMicros : null;
    const estimatorVersion = cost.basis === "ESTIMATED" ? cost.estimatorVersion : null;
    const finalized = await sql<ReservationRow & { overage_micros: string | number | bigint }>`
      with locked as materialized (
        select id, organization_id, brand_id, account_id, amount_micros
        from budget_reservations where id = ${params.reservationId} and status = 'RESERVED'
        for update
      ), updated_account as (
        update budget_accounts a
        set spent_micros = a.spent_micros + ${settlementMicros.toString()}::bigint,
            reserved_micros = a.reserved_micros - r.amount_micros,
            status = case when ${settlementMicros.toString()}::bigint > r.amount_micros then 'EXCEEDED' else a.status end,
            updated_at = now()
        from locked r
        where a.id = r.account_id and a.organization_id = r.organization_id and a.brand_id = r.brand_id
          and a.reserved_micros >= r.amount_micros
        returning a.id, a.organization_id, a.brand_id, a.spent_micros, a.reserved_micros
      ), claimed as (
        update budget_reservations r
        set status = 'RECONCILED', actual_spent_micros = ${actualSpentMicros === null ? null : actualSpentMicros.toString()}::bigint,
            estimated_spent_micros = ${estimatedSpentMicros === null ? null : estimatedSpentMicros.toString()}::bigint,
            settled_spend_micros = ${settlementMicros.toString()}::bigint,
            cost_basis = ${cost.basis}, estimator_version = ${estimatorVersion}, reconciled_at = now()
        from locked l join updated_account a on a.id = l.account_id
        where r.id = l.id and r.status = 'RESERVED'
        returning r.id, r.organization_id, r.brand_id, r.account_id, r.amount_micros, r.status,
          r.created_at, r.expires_at, r.actual_spent_micros, r.estimated_spent_micros, r.settled_spend_micros, r.cost_basis
      ), inserted_ledger as (
        insert into budget_ledger_entries (
          id, organization_id, brand_id, account_id, reservation_id, entry_type,
          delta_spent_micros, delta_reserved_micros, balance_spent_micros, balance_reserved_micros, metadata
        )
        select ${randomUUID()}, c.organization_id, c.brand_id, c.account_id, c.id,
          case when ${settlementMicros.toString()}::bigint > c.amount_micros then 'RESERVATION_OVERAGE' else 'RESERVATION_RECONCILED' end,
          ${settlementMicros.toString()}::bigint, -c.amount_micros, a.spent_micros, a.reserved_micros,
          jsonb_build_object('costBasis', ${cost.basis}::text, 'settledSpendMicros', ${settlementMicros.toString()}::text,
            'estimatorVersion', ${estimatorVersion}::text, 'overageMicros', greatest(${settlementMicros.toString()}::bigint - c.amount_micros, 0))
        from claimed c join updated_account a on a.id = c.account_id
        returning id
      )
      select c.*, greatest(c.settled_spend_micros - c.amount_micros, 0) as overage_micros
      from claimed c join inserted_ledger l on true
    `;

    let res: (ReservationRow & { overage_micros?: string | number | bigint }) | undefined = finalized[0];
    let alreadyReconciled = false;
    if (!res) {
      const existing = await sql<ReservationRow>`
        select id, organization_id, brand_id, account_id, amount_micros, actual_spent_micros, estimated_spent_micros,
          settled_spend_micros, cost_basis, status, created_at, expires_at
        from budget_reservations where id = ${params.reservationId} limit 1
      `;
      res = existing[0];
      if (!res || res.status !== "RECONCILED" || res.settled_spend_micros == null) {
        throw new Error(`Reservation '${params.reservationId}' not found or already released.`);
      }
      alreadyReconciled = true;
      res.overage_micros = BigInt(res.settled_spend_micros) > BigInt(res.amount_micros)
        ? BigInt(res.settled_spend_micros) - BigInt(res.amount_micros)
        : 0n;
    }

    const reservedMicros = BigInt(res.amount_micros);
    const settledRecorded = BigInt(res.settled_spend_micros ?? settlementMicros);
    const unusedReleasedMicros = reservedMicros > settledRecorded ? reservedMicros - settledRecorded : 0n;
    const overageMicros = BigInt(res.overage_micros ?? 0);

    return {
      reservation: {
        id: res.id,
        organizationId: res.organization_id,
        brandId: res.brand_id,
        accountId: res.account_id,
        amountMicros: reservedMicros,
        status: res.status,
        createdAt: res.created_at,
        expiresAt: res.expires_at,
      },
      unusedReleasedMicros,
      overageMicros,
      alreadyReconciled,
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
    const released = await sql<{ id: string }>`
      with locked as materialized (
        select id, organization_id, brand_id, account_id, amount_micros
        from budget_reservations where id = ${params.reservationId} and status = 'RESERVED'
        for update
      ), updated_account as (
        update budget_accounts a set reserved_micros = a.reserved_micros - r.amount_micros, updated_at = now()
        from locked r where a.id = r.account_id and a.organization_id = r.organization_id
          and a.brand_id = r.brand_id and a.reserved_micros >= r.amount_micros
        returning a.id, a.organization_id, a.brand_id, a.spent_micros, a.reserved_micros
      ), claimed as (
        update budget_reservations r set status = 'RELEASED', released_at = now()
        from locked l join updated_account a on a.id = l.account_id
        where r.id = l.id and r.status = 'RESERVED'
        returning r.id, r.organization_id, r.brand_id, r.account_id, r.amount_micros
      ), inserted_ledger as (
        insert into budget_ledger_entries (
          id, organization_id, brand_id, account_id, reservation_id, entry_type,
          delta_spent_micros, delta_reserved_micros, balance_spent_micros, balance_reserved_micros, metadata
        )
        select ${randomUUID()}, c.organization_id, c.brand_id, c.account_id, c.id, 'RESERVATION_RELEASED', 0,
          -c.amount_micros, a.spent_micros, a.reserved_micros, ${JSON.stringify({ reason: params.reason })}::jsonb
        from claimed c join updated_account a on a.id = c.account_id returning id
      )
      select c.id from claimed c join inserted_ledger l on true
    `;
    return released.length > 0;
  }
}
