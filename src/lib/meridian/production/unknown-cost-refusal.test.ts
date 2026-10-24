import assert from "node:assert/strict";
import { test } from "node:test";
import { getSql } from "../../db.ts";
import { createTenantFixture, execute, injectProvider, job } from "../testing/production-fixtures.ts";

const MODEL = "gemini-omni-1.1-flash";

test("a video whose provider declares no price is refused before any job row or provider call, and never stored as a zero-cost job", async () => {
  const sql = await getSql();
  const tenant = await createTenantFixture(sql, "cost-unknown", null, "google_omni", MODEL);
  const injected = injectProvider("google_omni", async (spec) => job(spec, "QUEUED"), undefined, { costPerSecondEstimateUsd: undefined });
  try {
    await assert.rejects(execute(sql, tenant, tenant.plan), /Video cost is not known for provider 'google_omni'\. No job was created\./);
    assert.equal(injected.submitted.length, 0, "no provider call");
    const rows = await sql`select id from production_jobs where creative_plan_id = ${tenant.plan.id}`;
    assert.equal(rows.length, 0, "no job row exists for an unpriced video");
  } finally {
    injected.restore();
  }
});
