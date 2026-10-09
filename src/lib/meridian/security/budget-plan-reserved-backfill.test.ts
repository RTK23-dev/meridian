import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

// Upgrade test: a database that is at migration 0035, holding reservations created before
// plan_reserved_micros existed, must come out of migration 0036 with the cumulative totals.
// This applies the real migration files in order. It runs on PGlite, which is real PostgreSQL
// compiled to WASM; it is a single connection, which is sufficient for a schema migration.

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "migrations");

test("migration 0036 backfills creative_plans.plan_reserved_micros from existing reservations", async () => {
  const pg = new PGlite({ extensions: { vector } });
  try {
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort((a, b) => a.localeCompare(b));
    const before = files.filter((f) => f < "0036_");
    assert.ok(before.includes("0035_budget_cost_provenance.sql"), "fixture: the 0035 schema must exist");
    for (const file of before) {
      await pg.exec(await readFile(join(migrationsDir, file), "utf8"));
    }

    await pg.exec(`
      insert into organizations (id, name, slug, created_by) values ('org-up', 'Up', 'org-up', 'test-user');
      insert into brands (id, organization_id, name, created_by) values ('brand-up', 'org-up', 'Up', 'test-user');
      insert into budget_accounts (id, organization_id, brand_id, max_spend_micros) values ('acct-up', 'org-up', 'brand-up', 100000000);
      insert into creative_plans (id, organization_id, brand_id, version, status, scope, autonomy, objective, plan_payload, spend_cap_usd)
        values
          ('plan-two-reservations', 'org-up', 'brand-up', '1', 'completed', 'video_only', 'semi_automatic', 'c', '{}', 20),
          ('plan-no-reservations', 'org-up', 'brand-up', '1', 'draft', 'video_only', 'semi_automatic', 'c', '{}', null);
      insert into budget_reservations (id, organization_id, brand_id, account_id, creative_plan_id, amount_micros, status)
        values
          ('res-1', 'org-up', 'brand-up', 'acct-up', 'plan-two-reservations', 3000000, 'RELEASED'),
          ('res-2', 'org-up', 'brand-up', 'acct-up', 'plan-two-reservations', 4500000, 'RECONCILED'),
          ('res-3', 'org-up', 'brand-up', 'acct-up', null, 1000000, 'RESERVED');
    `);

    const migration0036 = await readFile(join(migrationsDir, "0036_creative_plan_reserved_micros.sql"), "utf8");
    await pg.exec(migration0036);

    const plans = await pg.query<{ id: string; plan_reserved_micros: number | string }>(
      "select id, plan_reserved_micros from creative_plans order by id",
    );
    const byId = Object.fromEntries(plans.rows.map((row) => [row.id, BigInt(row.plan_reserved_micros)]));
    // Every reservation ever made against the plan is counted, including released ones:
    // the counter is never decremented, so the backfill must match that rule.
    assert.equal(byId["plan-two-reservations"], 7_500_000n);
    assert.equal(byId["plan-no-reservations"], 0n);

    // Reservations without a plan do not contribute to any plan total.
    const untouchedReservations = await pg.query<{ count: number }>(
      "select count(*)::int as count from budget_reservations where creative_plan_id is null",
    );
    assert.equal(untouchedReservations.rows[0]!.count, 1);

    // The column enforces a non-negative total and defaults new plans to zero.
    await assert.rejects(pg.exec(`update creative_plans set plan_reserved_micros = -1 where id = 'plan-no-reservations'`));
    await pg.exec(`insert into creative_plans (id, organization_id, brand_id, version, status, scope, autonomy, objective, plan_payload)
      values ('plan-new', 'org-up', 'brand-up', '1', 'draft', 'video_only', 'semi_automatic', 'c', '{}')`);
    const fresh = await pg.query<{ plan_reserved_micros: number | string }>(
      "select plan_reserved_micros from creative_plans where id = 'plan-new'",
    );
    assert.equal(BigInt(fresh.rows[0]!.plan_reserved_micros), 0n);
  } finally {
    await pg.close();
  }
});
