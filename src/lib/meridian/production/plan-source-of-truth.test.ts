import assert from "node:assert/strict";
import { test } from "node:test";
import { getSql } from "../../db.ts";
import { createTenantFixture, execute, injectProvider, job } from "../testing/production-fixtures.ts";

const MODEL = "gemini-omni-1.1-flash";

test("production gates on the decision the plan recorded: a plan whose decision is gone is refused before any provider call, even though its brief keeps one", async () => {
  const sql = await getSql();
  const tenant = await createTenantFixture(sql, "sot-gate", null, "google_omni", MODEL);
  await sql`update creative_plans set decision_id = null where id = ${tenant.plan.id}`;
  const injected = injectProvider("google_omni", async (spec) => job(spec, "QUEUED"));
  try {
    await assert.rejects(execute(sql, tenant, tenant.plan), /CreativePlan has no JEV decision/);
    assert.equal(injected.submitted.length, 0, "no provider call");
  } finally {
    injected.restore();
  }
});

test("an approved plan executes on its recorded decision and does not need the brief's", async () => {
  const sql = await getSql();
  const tenant = await createTenantFixture(sql, "sot-ok", null, "google_omni", MODEL);
  await sql`update briefs set decision_id = null where id = ${tenant.briefId}`;
  const injected = injectProvider("google_omni", async (spec) => job(spec, "QUEUED"));
  try {
    await execute(sql, tenant, tenant.plan);
    assert.equal(injected.submitted.length, 1, "the plan's own lineage authorizes the submission");
  } finally {
    // The poller is database-wide, so this test releases its own queued job rather than leaving it for another tenant's run.
    await sql`update production_jobs set status = 'CANCELLED', error_message = 'released by test' where creative_plan_id = ${tenant.plan.id}`;
    injected.restore();
  }
});
