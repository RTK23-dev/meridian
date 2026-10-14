import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { enableAppAliases } from "../testing/module-aliases.ts";
import { factoryRunFor, planRowsFor, runRow, stageJob, studioTenant, type FactoryTenant } from "../testing/produce-fixtures.ts";

// The testing runtime enables the image double and the testing artifact store. Production never selects either.
process.env.MERIDIAN_TESTING_RUNTIME = "true";

// The stage uses the "@/" alias through its server modules, so the alias hook is registered before they load.
enableAppAliases();
const { executeFactoryJob } = await import("./worker.ts");

async function produce(sql: Sql, tenant: FactoryTenant, runId: string): Promise<string> {
  return executeFactoryJob(sql, stageJob(tenant, runId, "factory.produce"), { runId });
}

/** How many rows the produce stage could write for the organization. A run that stops at the engine writes none of them. */
async function writeCounts(sql: Sql, organizationId: string): Promise<Record<string, number>> {
  const rows = await sql<{ table_name: string; n: number }>`
    select 'creative_records' as table_name, count(*)::int as n from creative_records where organization_id = ${organizationId}
    union all select 'assets', count(*)::int from assets where organization_id = ${organizationId}
    union all select 'production_jobs', count(*)::int from production_jobs where organization_id = ${organizationId}
    union all select 'budget_reservations', count(*)::int from budget_reservations where organization_id = ${organizationId}
    union all select 'factory_costs', count(*)::int from factory_costs where organization_id = ${organizationId}
    union all select 'factory_creatives', count(*)::int from factory_creatives where organization_id = ${organizationId}
  `;
  return Object.fromEntries(rows.map((row) => [row.table_name, row.n]));
}

test("a run that names the Meridian video engine stops with the phase E3 reason, and writes no job, reservation, creative, asset or cost", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "factory-video-engine");
  const runId = await factoryRunFor(sql, tenant, { automation: "full", formats: ["video"], providers: { video: "engine" }, caps: { totalCents: 500 } });
  const [variantId] = await planRowsFor(sql, tenant, runId, ["video"]);

  const before = await writeCounts(sql, tenant.organizationId);
  assert.equal(await produce(sql, tenant, runId), "stopped:factory.produce", "the produce stage stops the run");
  const after = await writeCounts(sql, tenant.organizationId);
  assert.deepEqual(after, before, "no creative, asset, job, reservation, cost or link was written");

  const row = await runRow(sql, tenant, runId);
  assert.equal(row.status, "paused", "a provider that is not connected pauses the run, as a named provider that is not ready does");
  assert.equal(row.error, "The video engine cannot deliver videos yet (phase E3)");

  const [job] = await sql<{ n: number }>`select count(*)::int as n from production_jobs where id = ${`factory-${variantId}-video`.slice(0, 180)}`;
  assert.equal(job?.n, 0, "no production job exists for the video");
});
