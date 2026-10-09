import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { BudgetLedgerService } from "./budget-ledger.ts";
import { listHeldReservations, resolveHeldReservation } from "./held-reservations.ts";

/**
 * Held-reservation reconciliation: a reservation whose provider outcome is uncertain stays
 * RESERVED until an admin resolves it. These tests use the real ledger and production_jobs tables.
 */

async function insertUser(sql: Sql, userId: string) {
  await sql`insert into "user" (id, name, email, "emailVerified") values (${userId}, 'Fixture User', ${`${userId}@fixture.example`}, true)`;
}

async function insertTenant(sql: Sql, suffix: string, members: { userId: string; role: string }[]) {
  const organizationId = `org-held-${suffix}`;
  const brandId = `brand-held-${suffix}`;
  const creator = members[0].userId;
  for (const member of members) await insertUser(sql, member.userId);
  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, ${creator})`;
  for (const member of members) {
    await sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${member.userId}`}, ${organizationId}, ${member.userId}, ${member.role})`;
  }
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${organizationId}, ${brandId}, ${creator})`;
  return { organizationId, brandId };
}

/** Creates a production job in `status` and a RESERVED budget line linked to it, as a submission would. */
async function heldReservation(sql: Sql, tenant: { organizationId: string; brandId: string }, status: string, amountMicros = 2_500_000n) {
  const productionJobId = `job-held-${Math.random().toString(36).slice(2, 10)}`;
  await sql`
    insert into production_jobs (
      id, organization_id, brand_id, provider, provider_job_id, request_id, status_url, cancel_url,
      status, cost_mode, estimated_cost_cents, input, created_at, submitted_at, updated_at, creative_plan_id
    ) values (
      ${productionJobId}, ${tenant.organizationId}, ${tenant.brandId}, 'omni', null, null, null, null,
      ${status}, 'BALANCED', 250, '{}', now(), null, now(), null
    )
  `;
  const reservation = await BudgetLedgerService.reserve(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    amountMicros,
    productionJobId,
  });
  return { reservationId: reservation.id, productionJobId };
}

async function accountTotals(sql: Sql, brandId: string) {
  const rows = await sql<{ spent: string | number | bigint; reserved: string | number | bigint }>`
    select spent_micros as spent, reserved_micros as reserved from budget_accounts where brand_id = ${brandId}
  `;
  return { spent: BigInt(rows[0].spent), reserved: BigInt(rows[0].reserved) };
}

test("held reservations are listed for admins, and a member or another tenant cannot see or resolve them", async () => {
  const sql = await getSql();
  const suffix = `scope-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const admin = `admin-${suffix}`;
  const member = `member-${suffix}`;
  const outsider = `outsider-${suffix}`;
  const tenant = await insertTenant(sql, suffix, [{ userId: admin, role: "admin" }, { userId: member, role: "member" }]);
  const other = await insertTenant(sql, `${suffix}-other`, [{ userId: outsider, role: "admin" }]);
  const held = await heldReservation(sql, tenant, "SUBMISSION_UNKNOWN");

  const listed = await listHeldReservations(sql, admin, tenant.brandId);
  assert.deepEqual(listed.map((row) => row.reservationId), [held.reservationId]);
  assert.equal(listed[0].amountUsd, 2.5);
  assert.equal(listed[0].jobStatus, "SUBMISSION_UNKNOWN");

  await assert.rejects(listHeldReservations(sql, member, tenant.brandId), /permission|not available/);
  await assert.rejects(
    resolveHeldReservation(sql, member, { brandId: tenant.brandId, reservationId: held.reservationId, resolution: "not_accepted", note: "member tried to release" }),
    /permission|not available/,
  );
  await assert.rejects(listHeldReservations(sql, outsider, tenant.brandId), /permission|not available/);
  await assert.rejects(
    resolveHeldReservation(sql, outsider, { brandId: tenant.brandId, reservationId: held.reservationId, resolution: "not_accepted", note: "cross tenant attempt" }),
    /permission|not available/,
  );
  // A reservation id cannot be resolved through another brand the caller administers.
  await assert.rejects(
    resolveHeldReservation(sql, outsider, { brandId: other.brandId, reservationId: held.reservationId, resolution: "not_accepted", note: "wrong brand in the request" }),
    /not found in this brand/,
  );
  assert.equal((await accountTotals(sql, tenant.brandId)).reserved, 2_500_000n, "refused attempts must not move money");
});

test("not_accepted releases the held budget, marks the job, and audits the decision once", async () => {
  const sql = await getSql();
  const suffix = `release-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const admin = `admin-${suffix}`;
  const tenant = await insertTenant(sql, suffix, [{ userId: admin, role: "admin" }]);
  const held = await heldReservation(sql, tenant, "SUBMISSION_UNKNOWN");

  const result = await resolveHeldReservation(sql, admin, {
    brandId: tenant.brandId,
    reservationId: held.reservationId,
    resolution: "not_accepted",
    note: "Provider console shows no job for this request id.",
  });
  assert.equal(result.outcome, "RELEASED");
  assert.deepEqual(await accountTotals(sql, tenant.brandId), { spent: 0n, reserved: 0n });
  assert.deepEqual(await listHeldReservations(sql, admin, tenant.brandId), [], "a resolved reservation is no longer held");

  const jobs = await sql<{ status: string; error_code: string }>`select status, error_code from production_jobs where id = ${held.productionJobId}`;
  assert.deepEqual(jobs[0], { status: "FAILED", error_code: "OPERATOR_CONFIRMED_NOT_ACCEPTED" });

  await assert.rejects(
    resolveHeldReservation(sql, admin, {
      brandId: tenant.brandId,
      reservationId: held.reservationId,
      resolution: "not_accepted",
      note: "Second click on the same reservation.",
    }),
    /not held for reconciliation/,
  );
  const audits = await sql<{ count: number }>`
    select count(*)::int as count from audit_log
    where object_id = ${held.reservationId} and action = 'budget.held_reservation_resolved'
  `;
  assert.equal(Number(audits[0].count), 1, "exactly one audit record for the operator decision");
});

test("billed_no_artifact settles at the operator-recorded provider amount and requires a reference", async () => {
  const sql = await getSql();
  const suffix = `billed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const admin = `admin-${suffix}`;
  const tenant = await insertTenant(sql, suffix, [{ userId: admin, role: "admin" }]);
  const held = await heldReservation(sql, tenant, "FAILED", 2_500_000n);

  await assert.rejects(
    resolveHeldReservation(sql, admin, {
      brandId: tenant.brandId,
      reservationId: held.reservationId,
      resolution: "billed_no_artifact",
      note: "Provider billed the job but returned no file.",
      observedSpendUsd: 1.2,
    }),
    /invoice or usage reference/,
  );
  assert.deepEqual(await accountTotals(sql, tenant.brandId), { spent: 0n, reserved: 2_500_000n }, "a refused settlement must not move money");

  const result = await resolveHeldReservation(sql, admin, {
    brandId: tenant.brandId,
    reservationId: held.reservationId,
    resolution: "billed_no_artifact",
    note: "Provider billed the job but returned no file.",
    observedSpendUsd: 1.2,
    providerReference: "invoice-2026-10-0412",
  });
  assert.equal(result.outcome, "RECONCILED");
  assert.deepEqual(await accountTotals(sql, tenant.brandId), { spent: 1_200_000n, reserved: 0n });
  const rows = await sql<{ status: string; actual_spent_micros: string | number | bigint; cost_basis: string }>`
    select r.status, r.actual_spent_micros, r.cost_basis from budget_reservations r where r.id = ${held.reservationId}
  `;
  assert.equal(rows[0].status, "RECONCILED");
  assert.equal(BigInt(rows[0].actual_spent_micros), 1_200_000n);
  assert.equal(rows[0].cost_basis, "PROVIDER_ACTUAL");
});

test("a reservation whose job is still in flight is never offered for operator resolution", async () => {
  const sql = await getSql();
  const suffix = `inflight-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const admin = `admin-${suffix}`;
  const tenant = await insertTenant(sql, suffix, [{ userId: admin, role: "admin" }]);
  const inFlight = await heldReservation(sql, tenant, "PROCESSING");
  assert.deepEqual(await listHeldReservations(sql, admin, tenant.brandId), [], "in-flight work settles through the poller, not the operator");
  await assert.rejects(
    resolveHeldReservation(sql, admin, { brandId: tenant.brandId, reservationId: inFlight.reservationId, resolution: "not_accepted", note: "Trying to release live work." }),
    /not held for reconciliation/,
  );
  assert.equal((await accountTotals(sql, tenant.brandId)).reserved, 2_500_000n);
});
