import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import type { AutomationMode } from "./run-settings.ts";
import { executeFactoryJob } from "./worker.ts";
import {
  approveStage,
  factoryRunFor,
  planRowsFor,
  runRow,
  stageJob,
  stubImageProvider,
  studioTenant,
  type FactoryTenant,
} from "../../../test-support/lib/meridian/testing/produce-fixtures.ts";

// The testing runtime enables the image double and the testing artifact store. Production never selects either.
process.env.MERIDIAN_TESTING_RUNTIME = "true";

async function stage(sql: Sql, tenant: FactoryTenant, runId: string, jobType: string): Promise<string> {
  return executeFactoryJob(sql, stageJob(tenant, runId, jobType), { runId });
}

const CAPPED = { totalCents: 500 };

test("manual: production waits for a person, the stages after it hold, and each spend or publish step waits in turn", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "stage-manual");
  const runId = await factoryRunFor(sql, tenant, { automation: "manual", formats: ["image"], providers: { image: "google_nano_banana" }, caps: CAPPED });
  await planRowsFor(sql, tenant, runId, ["image"]);
  const stub = stubImageProvider();
  try {
    assert.equal(await stage(sql, tenant, runId, "factory.produce"), "awaiting-approval:factory.produce");
    assert.equal(stub.state.calls, 0, "no provider is called before a person approves production");
    const waiting = await runRow(sql, tenant, runId);
    assert.equal(waiting.status, "awaiting_approval");
    assert.equal(waiting.current_stage, "factory.produce");
    assert.equal(await stage(sql, tenant, runId, "factory.gate"), "held:factory.gate", "the gate holds while production waits");
    assert.equal(await stage(sql, tenant, runId, "factory.review"), "held:factory.review", "review holds while production waits");

    await approveStage(sql, tenant, runId, "factory.produce");
    assert.equal(await stage(sql, tenant, runId, "factory.produce"), "variants:1;creatives:1");
    assert.equal(stub.state.calls, 1, "the approved production calls the provider once");
  } finally {
    stub.restore();
  }
  assert.match(await stage(sql, tenant, runId, "factory.gate"), /^gated:/);
  assert.equal(await stage(sql, tenant, runId, "factory.review"), "awaiting-approval:factory.review", "manual review waits for a person");
  assert.equal(await stage(sql, tenant, runId, "factory.launch"), "held:factory.launch", "publishing holds behind review");
});

test("semi: production waits once, review runs on its own, and publishing waits for a person", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "stage-semi");
  const runId = await factoryRunFor(sql, tenant, { automation: "semi", formats: ["image"], providers: { image: "google_nano_banana" }, caps: CAPPED });
  await planRowsFor(sql, tenant, runId, ["image"]);
  const stub = stubImageProvider();
  try {
    assert.equal(await stage(sql, tenant, runId, "factory.produce"), "awaiting-approval:factory.produce");
    await approveStage(sql, tenant, runId, "factory.produce");
    assert.equal(await stage(sql, tenant, runId, "factory.produce"), "variants:1;creatives:1");
  } finally {
    stub.restore();
  }
  assert.match(await stage(sql, tenant, runId, "factory.gate"), /^gated:/);
  assert.match(await stage(sql, tenant, runId, "factory.review"), /^review:/, "semi does not stop at review");
  assert.equal(await stage(sql, tenant, runId, "factory.launch"), "awaiting-approval:factory.launch", "semi stops before publishing");
});

test("full: runs end to end inside its cap, and nothing waits for a person", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "stage-full");
  const runId = await factoryRunFor(sql, tenant, { automation: "full", formats: ["image"], providers: { image: "google_nano_banana" }, caps: CAPPED });
  await planRowsFor(sql, tenant, runId, ["image"]);
  const stub = stubImageProvider();
  try {
    assert.equal(await stage(sql, tenant, runId, "factory.produce"), "variants:1;creatives:1", "full produces without an approval");
  } finally {
    stub.restore();
  }
  assert.equal(stub.state.calls, 1);
  assert.match(await stage(sql, tenant, runId, "factory.gate"), /^gated:/);
  assert.match(await stage(sql, tenant, runId, "factory.review"), /^review:/);
  // Full reaches launch inside its cap. Launch reports what it sent, and an unapproved creative is counted, not sent.
  assert.match(await stage(sql, tenant, runId, "factory.launch"), /^launched:/, "full reaches launch inside its cap");
  const run = await runRow(sql, tenant, runId);
  assert.equal(run.status, "running", "no stop was recorded");
});

test("full with no spend cap stops before any spend, with the reason on the run", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "stage-full-nocap");
  const runId = await factoryRunFor(sql, tenant, { automation: "full", formats: ["image"], providers: { image: "google_nano_banana" } });
  await planRowsFor(sql, tenant, runId, ["image"]);
  const stub = stubImageProvider();
  try {
    assert.equal(await stage(sql, tenant, runId, "factory.produce"), "stopped:factory.produce");
  } finally {
    stub.restore();
  }
  assert.equal(stub.state.calls, 0, "no provider is called without a cap");
  const run = await runRow(sql, tenant, runId);
  assert.equal(run.status, "paused");
  assert.match(run.error, /Full automation needs a spend cap/);
});

test("the kill switch stops every stage in every mode, approved or not", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "stage-kill");
  await sql`
    insert into factory_kill_switches (organization_id, brand_id, scope, engaged, actor_id)
    values (${tenant.organizationId}, null, 'workspace', true, ${tenant.userId})
  `;
  const modes: AutomationMode[] = ["manual", "semi", "full"];
  for (const automation of modes) {
    for (const jobType of ["factory.grade", "factory.produce", "factory.launch"]) {
      const runId = await factoryRunFor(sql, tenant, { automation, formats: ["image"], providers: { image: "google_nano_banana" }, caps: CAPPED });
      await planRowsFor(sql, tenant, runId, ["image"]);
      await approveStage(sql, tenant, runId, jobType);
      assert.equal(await stage(sql, tenant, runId, jobType), `stopped:${jobType}`, `${automation} ${jobType} is stopped`);
      const run = await runRow(sql, tenant, runId);
      assert.equal(run.status, "paused");
      assert.match(run.error, /kill switch is engaged/);
    }
  }
});

test("a run whose metered spend has reached its cap stops before it spends again", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "stage-cap-reached");
  const runId = await factoryRunFor(sql, tenant, { automation: "manual", formats: ["image"], providers: { image: "google_nano_banana" }, caps: { totalCents: 40 } });
  await planRowsFor(sql, tenant, runId, ["image"]);
  await sql`
    insert into factory_costs (id, organization_id, brand_id, run_id, stage, cents, seconds)
    values (${randomUUID()}, ${tenant.organizationId}, ${tenant.brandId}, ${runId}, 'factory.produce', 40, 0)
  `;
  await approveStage(sql, tenant, runId, "factory.produce");
  const stub = stubImageProvider();
  try {
    assert.equal(await stage(sql, tenant, runId, "factory.produce"), "stopped:factory.produce");
  } finally {
    stub.restore();
  }
  assert.equal(stub.state.calls, 0, "the cap is checked before the spend, so the provider is not called");
  const run = await runRow(sql, tenant, runId);
  assert.equal(run.error, "The spend cap for this run is reached.");
});

test("the brand's daily cap applies to a run that has spent it today", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "stage-daily-cap");
  await sql`
    insert into factory_spend_caps (organization_id, brand_id, daily_cents, total_cents, updated_by)
    values (${tenant.organizationId}, ${tenant.brandId}, 30, 0, ${tenant.userId})
  `;
  const runId = await factoryRunFor(sql, tenant, { automation: "full", formats: ["image"], providers: { image: "google_nano_banana" } });
  await planRowsFor(sql, tenant, runId, ["image"]);
  await sql`
    insert into factory_costs (id, organization_id, brand_id, run_id, stage, cents, seconds)
    values (${randomUUID()}, ${tenant.organizationId}, ${tenant.brandId}, ${runId}, 'factory.produce', 30, 0)
  `;
  const stub = stubImageProvider();
  try {
    assert.equal(await stage(sql, tenant, runId, "factory.produce"), "stopped:factory.produce");
  } finally {
    stub.restore();
  }
  assert.equal(stub.state.calls, 0);
  const run = await runRow(sql, tenant, runId);
  assert.equal(run.error, "The daily spend cap for this brand is reached.");
});
