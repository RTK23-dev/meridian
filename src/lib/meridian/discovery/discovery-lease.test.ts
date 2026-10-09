import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { DiscoveryFrontierService, FrontierStatus } from "./frontier.ts";

test("Discovery Lease: safe claiming, heartbeat, and transactional expansion", async () => {
  const sql = await getSql();
  const orgId = "org-lease-" + Date.now();
  const brandId = "brand-lease-" + Date.now();
  const runId = "crawll_lease_" + Date.now();

  await sql`insert into organizations (id, name, slug, created_by) values (${orgId}, 'Lease Org', ${orgId}, 'test-user') on conflict do nothing`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${orgId}, 'Lease Brand', 'test-user') on conflict do nothing`;
  await sql`
    insert into discovery_runs (
      id, organization_id, brand_id, scope, status, seeds, budget, progress, per_source_errors, started_at
    ) values (
      ${runId}, ${orgId}, ${brandId}, 'page_plus_links', 'running',
      '["https://example.com/start"]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now()
    )
  `;

  // 1. Enqueue initial seed
  const count = await DiscoveryFrontierService.enqueueLinks(sql, {
    organizationId: orgId,
    brandId,
    runId,
    links: [{ url: "https://example.com/start", depth: 0, priority: 10 }],
  });
  assert.equal(count, 1, "Must enqueue 1 seed");

  // 2. Worker 1 claims item
  const item1 = await DiscoveryFrontierService.claimNextItem(sql, {
    organizationId: orgId,
    brandId,
    runId,
    workerId: "worker-1",
    leaseSeconds: 30,
  });
  assert.ok(item1);
  assert.equal(item1.status, FrontierStatus.LEASED);
  assert.equal(item1.leaseOwner, "worker-1");
  assert.equal(item1.attempts, 1);

  // 3. Worker 2 attempts to claim next item simultaneously - should be null since only 1 item exists and is leased
  const item2 = await DiscoveryFrontierService.claimNextItem(sql, {
    organizationId: orgId,
    brandId,
    runId,
    workerId: "worker-2",
  });
  assert.equal(item2, null, "Worker 2 must not claim item held by Worker 1");

  // 4. Worker 1 heartbeats
  const heartbeated = await DiscoveryFrontierService.heartbeat(sql, {
    itemId: item1.id,
    workerId: "worker-1",
    organizationId: orgId,
    brandId,
    runId,
    leaseSeconds: 60,
  });
  assert.equal(heartbeated, true, "Heartbeat must succeed for lease owner");

  // Heartbeat by wrong worker must fail
  const badHeartbeat = await DiscoveryFrontierService.heartbeat(sql, {
    itemId: item1.id,
    workerId: "worker-impostor",
    organizationId: orgId,
    brandId,
    runId,
  });
  assert.equal(badHeartbeat, false, "Heartbeat by wrong worker must fail");

  // 5. Worker 1 marks processing
  const processing = await DiscoveryFrontierService.markProcessing(sql, {
    itemId: item1.id,
    workerId: "worker-1",
    organizationId: orgId,
    brandId,
    runId,
  });
  assert.equal(processing, true, "Mark processing must succeed");

  // 6. Worker 1 completes item and transactionally expands 2 discovered links
  await DiscoveryFrontierService.completeItem(sql, {
    itemId: item1.id,
    workerId: "worker-1",
    organizationId: orgId,
    brandId,
    runId,
    currentDepth: 0,
    maxDepth: 2,
    discoveredLinks: [
      "https://example.com/page-1",
      "https://example.com/page-2",
    ],
  });

  await assert.rejects(
    DiscoveryFrontierService.completeItem(sql, {
      itemId: item1.id,
      workerId: "worker-1",
      organizationId: orgId,
      brandId,
      runId,
      currentDepth: 0,
      maxDepth: 2,
      discoveredLinks: ["https://example.com/duplicate-retry"],
    }),
    /lost its lease/,
  );

  // Verify item1 is completed
  const rows = await sql<Record<string, unknown>>`
    select status, completed_at, lease_owner from discovery_frontier where id = ${item1.id}
  `;
  assert.equal(rows[0].status, FrontierStatus.COMPLETED);
  assert.ok(rows[0].completed_at);
  assert.equal(rows[0].lease_owner, null);

  // Worker 2 can now claim one of the newly expanded links
  const expandedItem = await DiscoveryFrontierService.claimNextItem(sql, {
    organizationId: orgId,
    brandId,
    runId,
    workerId: "worker-2",
  });
  assert.ok(expandedItem);
  assert.equal(expandedItem.status, FrontierStatus.LEASED);
  assert.equal(expandedItem.leaseOwner, "worker-2");
  assert.equal(expandedItem.depth, 1);

  const urls = await sql<{ count: number }>`
    select count(*)::int as count from discovery_frontier
    where run_id = ${runId} and organization_id = ${orgId} and brand_id = ${brandId}
  `;
  assert.equal(urls[0].count, 3, "A failed completion retry must not expand links a second time.");
});
