import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { DiscoveryFrontierService, FrontierStatus } from "./frontier.ts";

test("Discovery Restart & Recovery: expired leases reset to RETRY or FAILED", async () => {
  const sql = await getSql();
  const orgId = "org-restart-" + Date.now();
  const brandId = "brand-restart-" + Date.now();
  const runId = "crawll_restart_" + Date.now();

  await sql`insert into organizations (id, name, slug, created_by) values (${orgId}, 'Restart Org', ${orgId}, 'test-user') on conflict do nothing`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${orgId}, 'Restart Brand', 'test-user') on conflict do nothing`;
  await sql`
    insert into discovery_runs (
      id, organization_id, brand_id, scope, status, seeds, budget, progress, per_source_errors, started_at
    ) values (
      ${runId}, ${orgId}, ${brandId}, 'page_plus_links', 'running',
      '["https://example.com/dead"]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now()
    )
  `;

  // 1. Insert an item simulating a crashed worker with an expired lease (attempt 1)
  const staleId1 = `front_stale_1_${Date.now()}`;
  await sql`
    insert into discovery_frontier (
      id, organization_id, brand_id, run_id, url, status, attempts,
      lease_owner, lease_expires_at, discovered_at
    ) values (
      ${staleId1}, ${orgId}, ${brandId}, ${runId}, 'https://example.com/stale-1',
      'LEASED', 1, 'dead-worker-1', now() - interval '5 minutes', now()
    )
  `;

  // 2. Insert an item that crashed repeatedly and reached max attempts (e.g., attempt 5)
  const staleId2 = `front_stale_2_${Date.now()}`;
  await sql`
    insert into discovery_frontier (
      id, organization_id, brand_id, run_id, url, status, attempts,
      lease_owner, lease_expires_at, discovered_at
    ) values (
      ${staleId2}, ${orgId}, ${brandId}, ${runId}, 'https://example.com/stale-2',
      'PROCESSING', 5, 'dead-worker-2', now() - interval '10 minutes', now()
    )
  `;

  // 3. Run recovery on startup
  const recoveryResult = await DiscoveryFrontierService.recoverStaleDiscoveryWork(sql, {
    organizationId: orgId,
    brandId,
  });

  assert.equal(recoveryResult.recoveredCount, 1, "Must recover 1 stale item for retry");
  assert.equal(recoveryResult.failedCount, 1, "Must mark 1 max-attempt stale item as failed");

  // 4. Inspect DB status for staleId1
  const rows1 = await sql<Record<string, unknown>>`
    select status, next_attempt_at, lease_owner, last_error from discovery_frontier where id = ${staleId1}
  `;
  assert.equal(rows1[0].status, FrontierStatus.RETRY);
  assert.ok(rows1[0].next_attempt_at, "Must have next_attempt_at timestamp scheduled");
  assert.equal(rows1[0].lease_owner, null, "Lease owner must be cleared");

  // 5. Inspect DB status for staleId2
  const rows2 = await sql<Record<string, unknown>>`
    select status, completed_at, lease_owner, last_error from discovery_frontier where id = ${staleId2}
  `;
  assert.equal(rows2[0].status, FrontierStatus.FAILED);
  assert.ok(rows2[0].completed_at, "Failed item must have completed_at timestamp");
  assert.equal(rows2[0].lease_owner, null, "Lease owner must be cleared");
});
