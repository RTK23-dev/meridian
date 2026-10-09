/**
 * Operator reconciliation for held budget reservations.
 *
 * A reservation stays RESERVED when the provider's outcome is uncertain: the submission may or
 * may not have been accepted (SUBMISSION_UNKNOWN), or an accepted job failed after acceptance
 * (FAILED). Nothing settles these automatically, because releasing could hide a real charge.
 * An admin resolves each one explicitly, and the decision is recorded in the audit log.
 *
 * Both resolutions go through BudgetLedgerService, which is guarded by status = 'RESERVED', so a
 * repeated or concurrent resolution cannot settle the same reservation twice.
 */

import { assertRole, isRole } from "../access.ts";
import type { Sql } from "../learning/store.ts";
import { BudgetLedgerService, InvalidBudgetCapError, toMicros } from "./budget-ledger.ts";

/** Brand lookup, membership and the admin role check, in the same order as the studio's requireBrand. */
async function requireBrandAdmin(sql: Sql, userId: string, brandId: string): Promise<{ organizationId: string }> {
  const brands = await sql<{ organization_id: string }>`
    select organization_id from brands where id = ${brandId} and deleted_at is null limit 1
  `;
  const organizationId = brands[0]?.organization_id;
  if (!organizationId) throw new Error("Brand not found.");
  const members = await sql<{ role: string }>`
    select role from memberships where user_id = ${userId} and organization_id = ${organizationId} limit 1
  `;
  const role = members[0]?.role;
  if (!role || !isRole(role)) throw new Error("That workspace is not available to you.");
  assertRole(role, "admin");
  return { organizationId };
}

/**
 * not_accepted: the provider confirms no job was accepted or billed. The reservation is released.
 * billed_no_artifact: the provider billed the job, but no artifact was delivered. The reservation
 * is settled at the operator-recorded provider amount.
 */
export const HELD_RESERVATION_RESOLUTIONS = ["not_accepted", "billed_no_artifact"] as const;
export type HeldReservationResolution = (typeof HELD_RESERVATION_RESOLUTIONS)[number];

const MIN_NOTE_LENGTH = 10;
const MAX_NOTE_LENGTH = 500;

export interface HeldReservation {
  reservationId: string;
  productionJobId: string;
  provider: string;
  jobStatus: string;
  errorCode: string;
  errorMessage: string;
  amountUsd: number;
  heldSince: string;
  creativePlanId: string | null;
}

export interface ResolveHeldReservationInput {
  brandId: string;
  reservationId: string;
  resolution: HeldReservationResolution;
  note: string;
  providerReference?: string;
  observedSpendUsd?: number;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** Lists the brand's held reservations for an admin. Tenant-scoped: other brands never appear. */
export async function listHeldReservations(sql: Sql, userId: string, brandId: string): Promise<HeldReservation[]> {
  const access = await requireBrandAdmin(sql, userId, brandId);
  const rows = await sql<{
    reservation_id: string;
    production_job_id: string;
    provider: string;
    job_status: string;
    error_code: string | null;
    error_message: string | null;
    amount_micros: string | number | bigint;
    held_since: string;
    creative_plan_id: string | null;
  }>`
    select r.id as reservation_id, r.production_job_id, p.provider, p.status as job_status,
           p.error_code, p.error_message, r.amount_micros, r.created_at as held_since, r.creative_plan_id
    from budget_reservations r
    join production_jobs p
      on p.id = r.production_job_id and p.organization_id = r.organization_id and p.brand_id = r.brand_id
    where r.organization_id = ${access.organizationId} and r.brand_id = ${brandId}
      and r.status = 'RESERVED' and p.status in ('SUBMISSION_UNKNOWN', 'FAILED')
    order by r.created_at asc
  `;
  return rows.map((row) => ({
    reservationId: text(row.reservation_id),
    productionJobId: text(row.production_job_id),
    provider: text(row.provider),
    jobStatus: text(row.job_status),
    errorCode: text(row.error_code),
    errorMessage: text(row.error_message),
    amountUsd: Number(BigInt(row.amount_micros)) / 1_000_000,
    heldSince: text(row.held_since),
    creativePlanId: row.creative_plan_id ?? null,
  }));
}

/**
 * Resolves one held reservation. Admin only, tenant-scoped, and idempotent by construction:
 * a reservation that is no longer RESERVED is refused rather than settled again.
 */
export async function resolveHeldReservation(
  sql: Sql,
  userId: string,
  input: ResolveHeldReservationInput,
): Promise<{ reservationId: string; resolution: HeldReservationResolution; outcome: "RELEASED" | "RECONCILED" }> {
  const access = await requireBrandAdmin(sql, userId, input.brandId);
  if (!(HELD_RESERVATION_RESOLUTIONS as readonly string[]).includes(input.resolution)) {
    throw new InvalidBudgetCapError(`Unknown resolution '${String(input.resolution)}'.`);
  }
  const note = input.note.trim();
  if (note.length < MIN_NOTE_LENGTH || note.length > MAX_NOTE_LENGTH) {
    throw new InvalidBudgetCapError(`Record why this outcome was resolved (${MIN_NOTE_LENGTH}-${MAX_NOTE_LENGTH} characters).`);
  }

  const rows = await sql<{
    production_job_id: string;
    provider: string;
    reservation_status: string;
    job_status: string;
  }>`
    select r.production_job_id, p.provider, r.status as reservation_status, p.status as job_status
    from budget_reservations r
    join production_jobs p
      on p.id = r.production_job_id and p.organization_id = r.organization_id and p.brand_id = r.brand_id
    where r.id = ${input.reservationId} and r.organization_id = ${access.organizationId} and r.brand_id = ${input.brandId}
    limit 1
  `;
  const row = rows[0];
  if (!row) throw new Error("Reservation not found in this brand.");
  if (row.reservation_status !== "RESERVED" || !["SUBMISSION_UNKNOWN", "FAILED"].includes(row.job_status)) {
    throw new Error("This reservation is not held for reconciliation. Nothing was changed.");
  }

  let outcome: "RELEASED" | "RECONCILED";
  let auditMetadata: Record<string, unknown> = { resolution: input.resolution, note, provider: row.provider, productionJobId: row.production_job_id };
  if (input.resolution === "not_accepted") {
    const released = await BudgetLedgerService.release(sql, {
      reservationId: input.reservationId,
      reason: `Operator confirmed the provider did not accept or bill the job: ${note}`,
    });
    if (!released) throw new Error("This reservation was settled by another request. Nothing was changed.");
    outcome = "RELEASED";
    await sql`
      update production_jobs
      set status = 'FAILED', error_code = 'OPERATOR_CONFIRMED_NOT_ACCEPTED', error_message = ${note}, updated_at = now()
      where id = ${row.production_job_id} and organization_id = ${access.organizationId} and brand_id = ${input.brandId}
    `;
  } else {
    const observed = input.observedSpendUsd;
    const reference = (input.providerReference ?? "").trim();
    if (typeof observed !== "number" || !Number.isFinite(observed) || observed < 0) {
      throw new InvalidBudgetCapError("Record the provider-billed amount in USD (a finite number of zero or more).");
    }
    if (reference.length < 1 || reference.length > 200) {
      throw new InvalidBudgetCapError("Record the provider invoice or usage reference for the billed amount.");
    }
    await BudgetLedgerService.reconcile(sql, {
      reservationId: input.reservationId,
      cost: { basis: "PROVIDER_ACTUAL", amountMicros: toMicros(observed) },
    });
    outcome = "RECONCILED";
    auditMetadata = { ...auditMetadata, observedSpendUsd: observed, providerReference: reference };
    await sql`
      update production_jobs
      set status = 'FAILED', error_code = 'OPERATOR_RECONCILED_BILLING', error_message = ${note}, updated_at = now()
      where id = ${row.production_job_id} and organization_id = ${access.organizationId} and brand_id = ${input.brandId}
    `;
  }

  await sql`
    insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
    values (
      ${crypto.randomUUID()}, ${access.organizationId}, ${input.brandId}, ${userId},
      'budget.held_reservation_resolved', 'budget_reservation', ${input.reservationId},
      ${JSON.stringify({ ...auditMetadata, outcome })}
    )
  `;
  return { reservationId: input.reservationId, resolution: input.resolution, outcome };
}
