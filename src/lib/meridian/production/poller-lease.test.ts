import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { pollProductionJobs } from "./poller.ts";

test("production pollers atomically lease a due job and do not claim it twice", async () => {
  const sql = await getSql();
  const id = globalThis.crypto.randomUUID();
  const organizationId = `org-poller-${id}`;
  const brandId = `brand-poller-${id}`;
  const specId = `spec-poller-${id}`;
  const jobId = `job-poller-${id}`;

  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, 'Poller Test', ${organizationId}, 'test-user')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${organizationId}, 'Poller Test', 'test-user')`;
  await sql`insert into production_specs (id, organization_id, brand_id, spec) values (${specId}, ${organizationId}, ${brandId}, '{}'::jsonb)`;
  await sql`
    insert into production_jobs (id, organization_id, brand_id, production_spec_id, provider, status, input)
    values (${jobId}, ${organizationId}, ${brandId}, ${specId}, 'unregistered-test-provider', 'QUEUED', '{}'::jsonb)
  `;

  const [first, second] = await Promise.all([
    pollProductionJobs(sql, { organizationId }),
    pollProductionJobs(sql, { organizationId }),
  ]);

  assert.equal(first.claimed + second.claimed, 1, "Concurrent workers must not claim the same due job");
  const rows = await sql<{ status: string; next_poll_at: string | null }>`
    select status, next_poll_at from production_jobs where id = ${jobId}
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "FAILED", "Unregistered provider should fail closed");
  assert.ok(rows[0].next_poll_at, "Claimed row should have a persisted lease/retry deadline");
});
