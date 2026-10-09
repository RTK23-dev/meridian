import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Sql } from "../learning/store.ts";
import { BudgetExceededError, BudgetLedgerService, toMicros } from "./budget-ledger.ts";

/**
 * Cumulative plan-cap invariant on a real PostgreSQL server, with reservations issued from
 * separate pooled connections. It runs only when MERIDIAN_PG_TEST_URL names an admin
 * connection to a PostgreSQL server that may create databases. It never falls back to PGlite:
 * PGlite is one connection, so it cannot show the race this test is about.
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

/** Tagged-template SQL over a pool, so every statement may run on a different connection. */
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

async function withFreshMigratedDatabase<T>(run: (pool: pg.Pool, sql: Sql) => Promise<T>): Promise<T> {
  const database = `meridian_cap_${randomUUID().replace(/-/g, "")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database "${database}"`);
  await admin.end();

  const migrator = new pg.Client({ connectionString: urlWithDatabase(adminUrl!, database) });
  await migrator.connect();
  try {
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort((a, b) => a.localeCompare(b));
    for (const file of files) {
      await migrator.query(await readFile(join(migrationsDir, file), "utf8"));
    }
  } finally {
    await migrator.end();
  }

  const pool = new pg.Pool({ connectionString: urlWithDatabase(adminUrl!, database), max: 8 });
  // Idle clients can be closed by the server while the database is torn down below. Query errors reject
  // their own promises, so this listener only keeps that teardown signal from surfacing as an uncaught error.
  pool.on("error", () => {});
  try {
    return await run(pool, sqlOverPool(pool));
  } finally {
    await pool.end();
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`drop database if exists "${database}" with (force)`);
    await cleanup.end();
  }
}

async function tenantWithPlan(sql: Sql, capUsd: number | null, accountCapUsd: number) {
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `org-mc-${suffix}`;
  const brandId = `brand-mc-${suffix}`;
  const planId = `plan-mc-${suffix}`;
  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, 'test-user')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${organizationId}, ${brandId}, 'test-user')`;
  await BudgetLedgerService.getOrCreateAccount(sql, organizationId, brandId, accountCapUsd);
  await sql`
    insert into creative_plans (id, organization_id, brand_id, version, status, scope, autonomy, objective, plan_payload, budget_reserved_usd, spend_cap_usd)
    values (${planId}, ${organizationId}, ${brandId}, '1', 'executing', 'video_only', 'semi_automatic', 'conversion', '{}'::jsonb, 0, ${capUsd})
  `;
  return { organizationId, brandId, planId };
}

const maybe = adminUrl ? test : test.skip;

maybe("multi-connection: concurrent reservations from separate PostgreSQL connections never exceed the plan cap", async () => {
  await withFreshMigratedDatabase(async (_pool, sql) => {
    // Evidence that the reservations really contend across connections, not one serialized session.
    const pids = await Promise.all(Array.from({ length: 4 }, () => sql<{ pid: number }>`select pg_backend_pid() as pid`));
    assert.ok(new Set(pids.map((rows) => rows[0]!.pid)).size > 1, "fixture: queries must run on more than one backend");

    const tenant = await tenantWithPlan(sql, 6, 100);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        BudgetLedgerService.reserve(sql, {
          organizationId: tenant.organizationId,
          brandId: tenant.brandId,
          amountMicros: toMicros(3),
          creativePlanId: tenant.planId,
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    assert.equal(fulfilled.length, 2, "exactly two $3 reservations fit a $6 plan cap");
    for (const result of results) {
      if (result.status === "rejected") assert.ok(result.reason instanceof BudgetExceededError, String(result.reason));
    }

    const plan = await sql<{ plan_reserved_micros: string | number | bigint }>`
      select plan_reserved_micros from creative_plans where id = ${tenant.planId}
    `;
    const reservations = await sql<{ total: string | number | bigint }>`
      select coalesce(sum(amount_micros), 0) as total from budget_reservations where creative_plan_id = ${tenant.planId}
    `;
    const account = await BudgetLedgerService.getOrCreateAccount(sql, tenant.organizationId, tenant.brandId);
    assert.equal(BigInt(plan[0]!.plan_reserved_micros), 6_000_000n);
    assert.equal(BigInt(reservations[0]!.total), 6_000_000n, "plan total equals the sum of its reservations");
    assert.equal(account.reservedMicros, 6_000_000n, "account and plan agree");
  });
});

maybe("multi-connection: an account refusal under concurrency leaves the plan total untouched", async () => {
  await withFreshMigratedDatabase(async (_pool, sql) => {
    // The plan cap is generous; the account cap is the binding limit.
    const tenant = await tenantWithPlan(sql, 100, 5);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        BudgetLedgerService.reserve(sql, {
          organizationId: tenant.organizationId,
          brandId: tenant.brandId,
          amountMicros: toMicros(1),
          creativePlanId: tenant.planId,
        }),
      ),
    );

    assert.equal(results.filter((r) => r.status === "fulfilled").length, 5, "the $5 account cap admits five $1 reservations");
    const plan = await sql<{ plan_reserved_micros: string | number | bigint }>`
      select plan_reserved_micros from creative_plans where id = ${tenant.planId}
    `;
    // A refused reservation must not have advanced the plan total: the account gate and the
    // plan increment commit in one statement or not at all.
    assert.equal(BigInt(plan[0]!.plan_reserved_micros), 5_000_000n);
    const account = await BudgetLedgerService.getOrCreateAccount(sql, tenant.organizationId, tenant.brandId);
    assert.equal(account.reservedMicros, 5_000_000n);
  });
});
