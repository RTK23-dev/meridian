import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Sql } from "../learning/store.ts";
import { BudgetLedgerService } from "./budget-ledger.ts";
import { listHeldReservations, resolveHeldReservation } from "./held-reservations.ts";

/**
 * Held-reservation workflow on a real PostgreSQL server, with requests issued from separate pooled
 * connections. It runs only when MERIDIAN_PG_TEST_URL names an admin connection that may create
 * databases. It never falls back to PGlite, which is a single connection and cannot show a
 * concurrent double-resolve.
 *
 *   MERIDIAN_PG_TEST_URL=postgres://postgres@127.0.0.1:5432/postgres npm test
 */
const adminUrl = process.env.MERIDIAN_PG_TEST_URL?.trim();
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "migrations");

function urlWithDatabase(base: string, database: string) {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Tagged-template SQL over a pool, so each statement may run on a different connection. */
function sqlOverPool(pool: pg.Pool): Sql {
  const query = async <T>(text: string, params: unknown[] = []) => (await pool.query(text, params)).rows as T[];
  const tagged = (async <T>(strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? "";
    for (let index = 0; index < values.length; index += 1) text += `$${index + 1}${strings[index + 1] ?? ""}`;
    return query<T>(text, values);
  }) as unknown as Sql;
  tagged.query = query as Sql["query"];
  return tagged;
}

async function withFreshMigratedDatabase<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const database = `meridian_held_${randomUUID().replace(/-/g, "")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database "${database}"`);
  await admin.end();

  const migrator = new pg.Client({ connectionString: urlWithDatabase(adminUrl!, database) });
  await migrator.connect();
  try {
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort((a, b) => a.localeCompare(b));
    for (const file of files) await migrator.query(await readFile(join(migrationsDir, file), "utf8"));
  } finally {
    await migrator.end();
  }

  const pool = new pg.Pool({ connectionString: urlWithDatabase(adminUrl!, database), max: 8 });
  try {
    return await run(sqlOverPool(pool));
  } finally {
    await pool.end();
    const drop = new pg.Client({ connectionString: adminUrl });
    await drop.connect();
    await drop.query(`drop database "${database}" with (force)`);
    await drop.end();
  }
}

async function insertTenant(sql: Sql, members: { userId: string; role: string }[]) {
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `org-held-${suffix}`;
  const brandId = `brand-held-${suffix}`;
  const creator = members[0]!.userId;
  for (const member of members) {
    await sql`insert into "user" (id, name, email, "emailVerified") values (${member.userId}, 'Fixture User', ${`${member.userId}@fixture.example`}, true)`;
  }
  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, ${creator})`;
  for (const member of members) {
    await sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${member.userId}`}, ${organizationId}, ${member.userId}, ${member.role})`;
  }
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${organizationId}, ${brandId}, ${creator})`;
  return { organizationId, brandId };
}

/** A production job in `status`, and a RESERVED budget line linked to it, as a submission would leave them. */
async function heldReservation(sql: Sql, tenant: { organizationId: string; brandId: string }, status: string, amountMicros = 2_500_000n) {
  const productionJobId = `job-held-${randomUUID().slice(0, 12)}`;
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
  return { spent: BigInt(rows[0]!.spent), reserved: BigInt(rows[0]!.reserved) };
}

async function auditCount(sql: Sql, brandId: string) {
  const rows = await sql<{ count: number }>`
    select count(*)::int as count from audit_log where brand_id = ${brandId} and action = 'budget.held_reservation_resolved'
  `;
  return Number(rows[0]!.count);
}

const note = "Provider confirmed no job was accepted for this request.";

test("admin lists and releases a held reservation on PostgreSQL; member and other tenants are refused; a second resolve is refused", { skip: !adminUrl && "set MERIDIAN_PG_TEST_URL" }, async () => {
  await withFreshMigratedDatabase(async (sql) => {
    const admin = `user-admin-${randomUUID().slice(0, 6)}`;
    const member = `user-member-${randomUUID().slice(0, 6)}`;
    const tenant = await insertTenant(sql, [{ userId: admin, role: "admin" }, { userId: member, role: "member" }]);
    const outsiderOwner = `user-out-${randomUUID().slice(0, 6)}`;
    await insertTenant(sql, [{ userId: outsiderOwner, role: "owner" }]);
    const held = await heldReservation(sql, tenant, "SUBMISSION_UNKNOWN");
    const before = await accountTotals(sql, tenant.brandId);
    assert.equal(before.reserved, 2_500_000n);

    const listed = await listHeldReservations(sql, admin, tenant.brandId);
    assert.deepEqual(listed.map((row) => row.reservationId), [held.reservationId]);
    assert.equal(listed[0]!.jobStatus, "SUBMISSION_UNKNOWN");

    await assert.rejects(listHeldReservations(sql, member, tenant.brandId), /admin|permission|role/i);
    await assert.rejects(
      resolveHeldReservation(sql, member, { brandId: tenant.brandId, reservationId: held.reservationId, resolution: "not_accepted", note }),
      /admin|permission|role/i,
    );
    await assert.rejects(listHeldReservations(sql, outsiderOwner, tenant.brandId), /not available|not found/i);
    assert.equal((await accountTotals(sql, tenant.brandId)).reserved, 2_500_000n, "refused callers change nothing");

    const resolved = await resolveHeldReservation(sql, admin, {
      brandId: tenant.brandId, reservationId: held.reservationId, resolution: "not_accepted", note,
    });
    assert.equal(resolved.outcome, "RELEASED");
    const after = await accountTotals(sql, tenant.brandId);
    assert.equal(after.reserved, 0n, "the held budget is released");
    assert.equal(after.spent, 0n, "nothing is recorded as spent");
    assert.equal(await auditCount(sql, tenant.brandId), 1);
    assert.deepEqual(await listHeldReservations(sql, admin, tenant.brandId), [], "a resolved reservation is no longer held");

    await assert.rejects(
      resolveHeldReservation(sql, admin, { brandId: tenant.brandId, reservationId: held.reservationId, resolution: "not_accepted", note }),
      /not held for reconciliation|settled by another request|Nothing was changed/,
    );
    assert.equal(await auditCount(sql, tenant.brandId), 1, "a refused second resolve writes no audit row");
  });
});

test("billed_no_artifact on PostgreSQL settles at the operator-recorded amount, and concurrent resolves settle once", { skip: !adminUrl && "set MERIDIAN_PG_TEST_URL" }, async () => {
  await withFreshMigratedDatabase(async (sql) => {
    const admin = `user-admin-${randomUUID().slice(0, 6)}`;
    const tenant = await insertTenant(sql, [{ userId: admin, role: "admin" }]);
    const billed = await heldReservation(sql, tenant, "FAILED", 2_500_000n);
    await resolveHeldReservation(sql, admin, {
      brandId: tenant.brandId,
      reservationId: billed.reservationId,
      resolution: "billed_no_artifact",
      note: "Provider invoice shows the job was billed without a delivered artifact.",
      providerReference: "invoice-test-42",
      observedSpendUsd: 1.75,
    });
    const totals = await accountTotals(sql, tenant.brandId);
    assert.equal(totals.spent, 1_750_000n, "spent is the provider-billed amount");
    assert.equal(totals.reserved, 0n);

    const raced = await heldReservation(sql, tenant, "SUBMISSION_UNKNOWN", 1_000_000n);
    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        resolveHeldReservation(sql, admin, {
          brandId: tenant.brandId, reservationId: raced.reservationId, resolution: "not_accepted", note,
        }),
      ),
    );
    const succeeded = attempts.filter((a) => a.status === "fulfilled").length;
    assert.equal(succeeded, 1, "exactly one of the concurrent resolves may settle the reservation");
    const settled = await accountTotals(sql, tenant.brandId);
    assert.equal(settled.reserved, 0n);
    assert.equal(settled.spent, 1_750_000n, "the racing release does not change spend");
  });
});
