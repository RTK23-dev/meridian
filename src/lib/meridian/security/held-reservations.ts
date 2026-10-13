/**
 * Held budget reservations: the operator's reconciliation, and the one automatic release.
 *
 * A reservation stays RESERVED when the provider's outcome is uncertain: the submission may or may not have been accepted
 * (SUBMISSION_UNKNOWN), or an accepted job failed after acceptance (FAILED). An admin resolves each one explicitly, and the decision is
 * recorded in the audit log. Both resolutions go through BudgetLedgerService, which is guarded by status = 'RESERVED', so a repeated or
 * concurrent resolution cannot settle the same reservation twice.
 *
 * The one automatic release is the window sweep (releaseExpiredHolds). The owner decided it (NORTH_STAR section 2, decision D): a
 * submission whose window has passed with no outcome from the provider releases its budget. A submission that has an outcome (an
 * accepted job, a failure the provider reported, or a creative that was recorded) is never released by the sweep.
 */

import { randomUUID } from "node:crypto";
import { assertRole, isRole } from "../access.ts";
import { withTransaction, type Sql } from "../learning/store.ts";
import { BudgetLedgerService, InvalidBudgetCapError, toMicros } from "./budget-ledger.ts";
import { settleCreativePlanIfComplete } from "../production/materialization.ts";

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
    creative_plan_id: string | null;
  }>`
    select r.production_job_id, p.provider, r.status as reservation_status, p.status as job_status, p.creative_plan_id
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

  if (row.creative_plan_id) {
    await settleCreativePlanIfComplete(sql, {
      organizationId: access.organizationId,
      brandId: input.brandId,
      planId: row.creative_plan_id,
      actorId: userId,
    });
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

/** The reason and the actor a window release records. The Factory screen shows both. */
export const WINDOW_EXPIRED_REASON = "window_expired";
export const SYSTEM_ACTOR = "system";

/** The error code a job carries once its held budget was released by the window sweep. The poller reads only SUBMISSION_UNKNOWN jobs, so it leaves this one alone. */
export const SUBMISSION_WINDOW_EXPIRED_CODE = "SUBMISSION_WINDOW_EXPIRED";

/**
 * Whether a production job's submission has no outcome: it never reached the provider's answer, and no creative came of it. Only a job
 * that is still SUBMITTING or SUBMISSION_UNKNOWN, with no provider job id, qualifies. An accepted job, a job the provider failed, and a
 * job that produced a creative all have an outcome.
 */
export function submissionHasNoOutcome(job: { status: string; provider_job_id: string | null; materialized_creative_id: string | null }): boolean {
  return (job.status === "SUBMITTING" || job.status === "SUBMISSION_UNKNOWN")
    && !(job.provider_job_id ?? "").trim()
    && !job.materialized_creative_id;
}

/**
 * The window sweep (NORTH_STAR section 2, decision D). Releases each RESERVED reservation whose expires_at has passed and whose
 * submission has no outcome (submissionHasNoOutcome). Nothing is released before expires_at, and a reservation with an outcome is
 * never released. Each release is recorded with the reason window_expired and the actor system, on the ledger entry and in the audit
 * log. The job is marked FAILED with SUBMISSION_WINDOW_EXPIRED. The sweep runs in the worker's tick, across workspaces, and the
 * release is guarded by status = 'RESERVED', so a second sweep releases nothing more. Returns how many were released by this pass.
 */
export async function releaseExpiredHolds(sql: Sql): Promise<{ released: number }> {
  const candidates = await sql<{ id: string; organization_id: string; brand_id: string; production_job_id: string }>`
    select r.id, r.organization_id, r.brand_id, r.production_job_id
    from budget_reservations r
    join production_jobs p on p.id = r.production_job_id and p.organization_id = r.organization_id and p.brand_id = r.brand_id
    where r.status = 'RESERVED' and r.expires_at <= now()
      and p.status in ('SUBMITTING', 'SUBMISSION_UNKNOWN') and coalesce(p.provider_job_id, '') = '' and p.materialized_creative_id is null
    order by r.expires_at asc
    limit 50
  `;
  let released = 0;
  for (const candidate of candidates) {
    const done = await withTransaction(sql, async (tx) => {
      // The job is read under a lock and checked again, so an answer that arrived after the candidate was read keeps its reservation.
      const jobs = await tx<{ id: string; status: string; provider_job_id: string | null; materialized_creative_id: string | null; provider: string }>`
        select id, status, provider_job_id, materialized_creative_id, provider from production_jobs
        where id = ${candidate.production_job_id} and organization_id = ${candidate.organization_id} and brand_id = ${candidate.brand_id}
        for update
      `;
      const job = jobs[0];
      if (!job || !submissionHasNoOutcome(job)) return false;
      const didRelease = await BudgetLedgerService.release(tx, {
        reservationId: candidate.id,
        reason: WINDOW_EXPIRED_REASON,
        actor: SYSTEM_ACTOR,
      });
      if (!didRelease) return false;
      await tx`
        update production_jobs
        set status = 'FAILED', error_code = ${SUBMISSION_WINDOW_EXPIRED_CODE},
            error_message = 'The submission window passed with no outcome from the provider, so its held budget was released.', updated_at = now()
        where id = ${job.id} and organization_id = ${candidate.organization_id} and brand_id = ${candidate.brand_id}
          and status in ('SUBMITTING', 'SUBMISSION_UNKNOWN') and coalesce(provider_job_id, '') = ''
      `;
      await tx`
        insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
        values (
          ${randomUUID()}, ${candidate.organization_id}, ${candidate.brand_id}, ${SYSTEM_ACTOR}, 'budget.held_reservation_window_expired',
          'budget_reservation', ${candidate.id}, ${JSON.stringify({ reason: WINDOW_EXPIRED_REASON, productionJobId: job.id, provider: job.provider })}
        )
      `;
      return true;
    });
    if (done) released += 1;
  }
  return { released };
}

/** A held reservation the window sweep released, with the reason and the actor it recorded. */
export interface WindowRelease {
  reservationId: string;
  productionJobId: string;
  provider: string;
  amountUsd: number;
  reason: string;
  actor: string;
  releasedAt: string;
}

/** Lists the reservations the window sweep released in this brand, newest first. Admin only, tenant-scoped. */
export async function listWindowReleases(sql: Sql, userId: string, brandId: string): Promise<WindowRelease[]> {
  const access = await requireBrandAdmin(sql, userId, brandId);
  const rows = await sql<{
    reservation_id: string;
    production_job_id: string;
    provider: string;
    amount_micros: string | number | bigint;
    released_at: unknown;
    reason: string | null;
    actor: string | null;
  }>`
    select r.id as reservation_id, r.production_job_id, p.provider, r.amount_micros, r.released_at,
      e.metadata->>'reason' as reason, e.metadata->>'actor' as actor
    from budget_reservations r
    join production_jobs p on p.id = r.production_job_id and p.organization_id = r.organization_id and p.brand_id = r.brand_id
    join budget_ledger_entries e on e.reservation_id = r.id and e.entry_type = 'RESERVATION_RELEASED'
    where r.organization_id = ${access.organizationId} and r.brand_id = ${brandId}
      and r.status = 'RELEASED' and e.metadata->>'actor' = ${SYSTEM_ACTOR}
    order by r.released_at desc
    limit 50
  `;
  return rows.map((row) => ({
    reservationId: text(row.reservation_id),
    productionJobId: text(row.production_job_id),
    provider: text(row.provider),
    amountUsd: Number(BigInt(row.amount_micros)) / 1_000_000,
    reason: text(row.reason),
    actor: text(row.actor),
    releasedAt: text(row.released_at),
  }));
}
