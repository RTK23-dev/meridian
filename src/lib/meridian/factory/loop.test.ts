import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { approveCreative, organicRowsFor, paidRowsFor, producedCreative, runFor, stage } from "../../../test-support/lib/meridian/testing/factory-launch-fixtures.ts";
import { approveStage, runRow, studioTenant } from "../../../test-support/lib/meridian/testing/produce-fixtures.ts";

// NORTH_STAR section 8, item 8 and the back half of section 7. The front half (discover, grade, pick, template) has its own suites
// (gather.test.ts, grade-jev.test.ts, pick-surfaces.test.ts, run-finish.test.ts), and the organic measured leg needs a connected
// channel, which publish.test.ts covers. This test runs one run with intent both from produce to learn, on fixtures.

test("one run with intent both: produce, gate and review make the creative, launch leaves one receipt per surface, and learn finishes the run from a measured paid outcome", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "loop-both");
  const runId = await runFor(sql, tenant, "full", "both", ["youtube"]);
  const creativeId = await producedCreative(sql, tenant, runId, "full");
  await approveCreative(sql, creativeId);

  // Launch: one organic receipt (not connected here, so it says so) and one paused ad, which is the paid receipt.
  assert.equal(
    await stage(sql, tenant, runId, "factory.launch"),
    "launched:organic=0;not_connected=1;paid_paused=1;failed=0;unapproved=0;blocked=0",
  );
  const organic = await organicRowsFor(sql, tenant, creativeId);
  assert.equal(organic.length, 1, "one organic receipt per creative");
  assert.equal(organic[0]?.surface, "organic");
  const paid = await paidRowsFor(sql, tenant, creativeId);
  assert.equal(paid.filter((row) => row.object_type === "ad").length, 1, "one paid receipt per creative");
  assert.equal(paid.some((row) => row.status === "active"), false, "nothing the launch made is active");

  // Test: records what a budget test would do. It waits for a person in every mode, and it switches nothing on.
  assert.equal(await stage(sql, tenant, runId, "factory.test"), "awaiting-approval:factory.test");
  await approveStage(sql, tenant, runId, "factory.test");
  await stage(sql, tenant, runId, "factory.test");
  const afterTest = await paidRowsFor(sql, tenant, creativeId);
  assert.equal(afterTest.every((row) => row.status === "paused"), true, "the test stage leaves every paid object paused");

  // Measure: the measurement pull stores one paid observation for the creative, with its surface (run-finish.test.ts stores the same
  // shape). The pull itself is covered by measurement/pull.test.ts.
  await sql`
    insert into unified_performance_telemetry (id, organization_id, brand_id, platform, source_type, creative_id, impressions, clicks, conversions, spend_cents)
    values (${`tel-${creativeId}`}, ${tenant.organizationId}, ${tenant.brandId}, 'meta', 'paid', ${creativeId}, 1000, 50, 2, 800)
  `;

  // Learn: one measured outcome of the run's own creatives finishes the run.
  const learned = await stage(sql, tenant, runId, "factory.learn");
  assert.match(learned, /^learned:\d+;run outcomes organic 0, paid 1;/);
  const run = await runRow(sql, tenant, runId);
  assert.equal(run.status, "succeeded", "a measured outcome of the run's own creative finishes it");
  assert.equal(run.error, "");
});
