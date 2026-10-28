// The sleep night's spend caps: each scope is checked on its own, and the reason a night stops names the scope that was reached.
// The database is PGlite with the migrations, so the spend rows and the caps are the real ones. The stage seam stops every night at
// discover, so a night that passes the caps shows that it passed, and no stage does real work.

import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutableJob } from "../jobs/execute.ts";
import type { Sql } from "../learning/store.ts";
import { FACTORY_TEST_BRAND, FACTORY_TEST_ORG, FACTORY_TEST_RUN, makeFactoryTestSql, seedFactoryRun } from "../../../test-support/lib/meridian/testing/factory-fixtures.ts";
import { runSleepNight } from "./sleep.ts";

const NOW = new Date("2026-10-15T12:00:00Z");

type NightCaps = {
  brandTotalCents?: number;
  brandDailyCents?: number;
  /** The brand's default run settings, as stored (run_defaults). Only the caps are set here. */
  runDefaults?: Record<string, unknown>;
};

/** A sleep mode set up for the test brand, with its caps and one metered cost of the brand's spend, recorded today. */
async function seedNight(sql: Sql, caps: NightCaps, spentCents: number): Promise<void> {
  await seedFactoryRun(sql, { settings: {}, level: 0, niche: "sleep aids", website: "", country: "us" });
  await sql`
    insert into sleep_mode_settings (organization_id, brand_id, enabled, night_time, time_zone, niche, updated_by)
    values (${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, true, '03:00', 'UTC', 'sleep aids', 'user-1')
  `;
  await sql`
    insert into factory_spend_caps (organization_id, brand_id, daily_cents, total_cents, updated_by)
    values (${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${caps.brandDailyCents ?? 0}, ${caps.brandTotalCents ?? 0}, 'user-1')
  `;
  await sql`update brands set run_defaults = ${JSON.stringify(caps.runDefaults ?? {})} where id = ${FACTORY_TEST_BRAND}`;
  if (spentCents > 0) {
    await sql`
      insert into factory_costs (id, organization_id, brand_id, run_id, stage, cents, seconds, provider, basis, created_at)
      values ('spend:caps', ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${FACTORY_TEST_RUN}, 'factory.produce', ${spentCents}, 0,
        'meta', 'provider_reported', now())
    `;
  }
}

function nightJob(): ExecutableJob {
  return {
    id: "job_caps",
    organization_id: FACTORY_TEST_ORG,
    brand_id: FACTORY_TEST_BRAND,
    job_type: "factory.sleep",
    payload: "{}",
    attempts: 1,
    max_attempts: 3,
  };
}

/** A stage stand-in that stops at once, as a run waiting for approval does. Reached only by a night that passed the caps. */
const haltAtDiscover = { stage: async (): Promise<string> => "awaiting-approval:fixture" };

async function nightRecord(sql: Sql): Promise<{ status: string; reason: string }> {
  const rows = await sql<{ status: string; reason: string }>`
    select status, reason from sleep_mode_nights where organization_id = ${FACTORY_TEST_ORG}
  `;
  assert.equal(rows.length, 1, "the night records one row");
  return rows[0] as { status: string; reason: string };
}

test("a saved full automation above the owner ceiling stops the night before a run starts", async () => {
  const sql = await makeFactoryTestSql();
  await seedNight(sql, { brandDailyCents: 1000, runDefaults: { automation: "full", caps: { dailyCents: 300 } } }, 0);
  assert.equal(await runSleepNight(sql, nightJob(), NOW, haltAtDiscover), "sleep:stopped");
  const night = await nightRecord(sql);
  assert.equal(night.reason, "That automation is above the owner ceiling for this brand.");
  const runs = await sql<{ n: number }>`
    select count(*)::int as n from factory_runs where organization_id = ${FACTORY_TEST_ORG} and created_by = 'user-1' and niche = 'sleep aids' and id <> ${FACTORY_TEST_RUN}
  `;
  assert.equal(runs[0]?.n, 0, "no night run is started above the ceiling");
});

test("a night run uses the saved automation level, not the old Live tests level", async () => {
  const sql = await makeFactoryTestSql();
  await seedNight(sql, { brandDailyCents: 1000, runDefaults: { automation: "manual", caps: { dailyCents: 300 } } }, 0);
  await sql`
    insert into factory_settings (organization_id, brand_id, level, ceiling, updated_by)
    values (${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, 0, 3, 'user-1')
  `;
  assert.equal(await runSleepNight(sql, nightJob(), NOW, haltAtDiscover), "sleep:stopped");
  const runs = await sql<{ level: number }>`
    select level from factory_runs
    where organization_id = ${FACTORY_TEST_ORG} and brand_id = ${FACTORY_TEST_BRAND} and id <> ${FACTORY_TEST_RUN}
  `;
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.level, 1, "manual automation is level 1 even when Live tests still says 0");
});

test("a brand's total cap reached by its spend across all runs stops the night, and the reason names the brand", async () => {
  const sql = await makeFactoryTestSql();
  await seedNight(sql, { brandTotalCents: 5000 }, 6000);
  assert.equal(await runSleepNight(sql, nightJob(), NOW, haltAtDiscover), "sleep:stopped");
  const night = await nightRecord(sql);
  assert.equal(night.status, "stopped");
  assert.equal(night.reason, "The spend cap for this brand is reached.");
});

test("a brand's daily cap reached today stops the night, and a stricter run default daily cap does not change the scope named", async () => {
  const sql = await makeFactoryTestSql();
  await seedNight(sql, { brandDailyCents: 1000, runDefaults: { caps: { dailyCents: 300 } } }, 1500);
  assert.equal(await runSleepNight(sql, nightJob(), NOW, haltAtDiscover), "sleep:stopped");
  const night = await nightRecord(sql);
  assert.equal(night.reason, "The daily spend cap for this brand is reached.");
});

test("a run's default daily cap is not checked against the brand's spend, so it does not stop the night", async () => {
  // The brand has spent 500 cents today, under its own daily cap of 1000. The run default of 300 is for a new run, which starts at zero,
  // so the night passes the caps and reaches the stage stand-in, which halts it at discover.
  const sql = await makeFactoryTestSql();
  await seedNight(sql, { brandDailyCents: 1000, runDefaults: { caps: { dailyCents: 300 } } }, 500);
  assert.equal(await runSleepNight(sql, nightJob(), NOW, haltAtDiscover), "sleep:stopped");
  const night = await nightRecord(sql);
  assert.match(night.reason, /The run stopped at factory\.discover/);
  assert.doesNotMatch(night.reason, /cap/i);
});
