import assert from "node:assert/strict";
import test from "node:test";
import { createPoolSql, getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { failingSql, seedBrandBrain, seedOpportunity } from "../testing/opportunity-fixtures.ts";
import { enableAppAliases } from "../testing/module-aliases.ts";
import { rerankBrand } from "./rerank.ts";

// The refresh action imports modules that use the "@/" alias, so the alias hook is registered before it is loaded.
enableAppAliases();
const { refreshOpportunitiesFor } = await import("./actions.ts");

const PG_TEST_URL = process.env.MERIDIAN_PG_TEST_URL?.trim();

/**
 * Both ranking writes replace the brand's open opportunities: the deletes of the open set, and the reinsertion of the ranked set.
 * A failure in the reinsertion must roll the deletes back, so the previous open set is still there (contract section 7).
 */
async function failedReplacementKeepsOpenSet(sql: Sql, replace: (failing: Sql, tenant: { organizationId: string; brandId: string; userId: string }) => Promise<unknown>) {
  const tenant = await studioTenant(sql, `rerank-atomic-${Math.random().toString(36).slice(2, 8)}`);
  await seedBrandBrain(sql, tenant);
  const kept = await seedOpportunity(sql, tenant, { angle: `kept_${Math.random().toString(36).slice(2, 8)}` });
  const openBefore = await sql<{ id: string }>`select id from opportunities where brand_id = ${tenant.brandId} and status = 'open'`;
  assert.equal(openBefore.length, 1, "the fixture has one open opportunity");

  await assert.rejects(replace(failingSql(sql, /insert into opportunities/), tenant), /injected write failure/);

  const [stillThere] = await sql<{ count: number }>`select count(*)::int as count from opportunities where id = ${kept.opportunityId}`;
  assert.equal(stillThere?.count, 1, "the failed replacement deleted nothing: the previous open opportunity is still there");
  const openAfter = await sql<{ id: string }>`select id from opportunities where brand_id = ${tenant.brandId} and status = 'open'`;
  assert.deepEqual(openAfter.map((row) => row.id), [kept.opportunityId], "the open set is exactly what it was before");
  const [reviews] = await sql<{ count: number }>`select count(*)::int as count from reviews where opportunity_id = ${kept.opportunityId}`;
  assert.equal(reviews?.count, 0, "the failed replacement did not touch the review rows either");

  // The same replacement, with nothing injected, does replace the open set.
  await replace(sql, tenant);
  const [replaced] = await sql<{ count: number }>`select count(*)::int as count from opportunities where id = ${kept.opportunityId}`;
  assert.equal(replaced?.count, 0, "a completed replacement removes the previous open opportunity");
}

const TARGETS = ["PGlite", "PostgreSQL"] as const;
for (const target of TARGETS) {
  test(`rerankBrand replaces the open set as one unit on ${target}: a failed reinsertion leaves the previous set in place`, async (t) => {
    if (target === "PostgreSQL" && !PG_TEST_URL) {
      t.skip("MERIDIAN_PG_TEST_URL is not set, so the PostgreSQL replacement check was not run");
      return;
    }
    if (target === "PGlite") {
      await failedReplacementKeepsOpenSet(await getSql(), (failing, tenant) => rerankBrand(failing, tenant.organizationId, tenant.brandId));
      return;
    }
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_TEST_URL });
    try {
      await failedReplacementKeepsOpenSet(createPoolSql(pool), (failing, tenant) => rerankBrand(failing, tenant.organizationId, tenant.brandId));
    } finally {
      await pool.end();
    }
  });

  test(`refreshOpportunitiesFor replaces the open set as one unit on ${target}: a failed reinsertion leaves the previous set in place`, async (t) => {
    if (target === "PostgreSQL" && !PG_TEST_URL) {
      t.skip("MERIDIAN_PG_TEST_URL is not set, so the PostgreSQL replacement check was not run");
      return;
    }
    const run = (sql: Sql) =>
      failedReplacementKeepsOpenSet(sql, (failing, tenant) => refreshOpportunitiesFor(failing, tenant.userId, tenant.brandId));
    if (target === "PGlite") {
      await run(await getSql());
      return;
    }
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_TEST_URL });
    try {
      await run(createPoolSql(pool));
    } finally {
      await pool.end();
    }
  });
}
