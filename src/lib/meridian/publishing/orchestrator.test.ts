import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../learning/store.ts";
import {
  buildIdempotencyKey,
  calculateBackoffSeconds,
  scheduleMultiAccountPublish,
  claimScheduledJobs,
  recordPublishSuccess,
  recordPublishFailure,
  cancelPublishJob,
  retryPublishJob,
  listBrandPublishingQueue,
  listBrandPublishingReceipts,
  PLATFORM_RATE_LIMITS,
} from "./orchestrator.ts";

test("Publishing Orchestrator: idempotency key generation is deterministic and minute-normalized", () => {
  const key1 = buildIdempotencyKey("cr_123", "acct_456", "2026-10-08T14:30:15.000Z");
  const key2 = buildIdempotencyKey("cr_123", "acct_456", "2026-10-08T14:30:45.000Z");
  const keyDifferentAcct = buildIdempotencyKey("cr_123", "acct_999", "2026-10-08T14:30:15.000Z");
  const keyDifferentTime = buildIdempotencyKey("cr_123", "acct_456", "2026-10-08T15:30:15.000Z");

  // Same minute window -> identical key (idempotency safety)
  assert.equal(key1, key2);
  assert.notEqual(key1, keyDifferentAcct);
  assert.notEqual(key1, keyDifferentTime);
  assert.equal(key1.length, 32);
});

test("Publishing Orchestrator: exponential backoff progression and rate limits", () => {
  assert.equal(calculateBackoffSeconds(0), 60);    // 1 min
  assert.equal(calculateBackoffSeconds(1), 120);   // 2 min
  assert.equal(calculateBackoffSeconds(2), 240);   // 4 min
  assert.equal(calculateBackoffSeconds(3), 480);   // 8 min
  assert.equal(calculateBackoffSeconds(10), 3600); // capped at 1 hr

  // Rate limit constants exist for supported platforms
  assert.ok(PLATFORM_RATE_LIMITS.instagram.maxPerHour > 0);
  assert.ok(PLATFORM_RATE_LIMITS.tiktok.maxPerHour > 0);
  assert.ok(PLATFORM_RATE_LIMITS.youtube.maxPerHour > 0);
});

test("Publishing Orchestrator: multi-account scheduling, atomic claiming, receipts, and tenant isolation", async () => {
  const pg = new PGlite();
  await pg.waitReady;

  await pg.exec(`
    create table if not exists platform_accounts (
      id text primary key,
      organization_id text not null,
      brand_id text not null,
      platform text not null,
      account_type text not null default 'social_page',
      external_account_id text not null,
      name text not null,
      handle text not null default '',
      avatar_url text not null default '',
      credential_id text,
      status text not null default 'connected',
      metadata jsonb not null default '{}',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists publishing_queues (
      id text primary key,
      organization_id text not null,
      brand_id text not null,
      creative_id text not null,
      target_account_id text not null,
      platform text not null,
      target_type text not null default 'organic',
      scheduled_time timestamptz not null default now(),
      status text not null default 'queued',
      idempotency_key text not null,
      attempts integer not null default 0,
      max_attempts integer not null default 3,
      next_retry_at timestamptz,
      receipt_id text,
      error text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists publishing_receipts (
      id text primary key,
      organization_id text not null,
      brand_id text not null,
      queue_id text,
      platform text not null,
      account_id text not null,
      external_post_id text not null default '',
      external_url text not null default '',
      status text not null default 'live',
      published_at timestamptz not null default now(),
      raw_response jsonb not null default '{}'
    );
  `);

  const sql: Sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let query = strings[0];
    const params: unknown[] = [];
    for (let i = 0; i < values.length; i++) {
      params.push(values[i]);
      query += `$${i + 1}` + strings[i + 1];
    }
    const res = await pg.query(query, params);
    return res.rows;
  }) as any;

  const orgA = "org_alpha";
  const brandA = "brand_alpha";
  const orgB = "org_beta";
  const brandB = "brand_beta";

  // Insert 2 connected platform accounts for Brand A
  await sql`
    insert into platform_accounts (id, organization_id, brand_id, platform, external_account_id, name, handle)
    values ('acct_ig_1', ${orgA}, ${brandA}, 'instagram', 'ext_ig_1', 'Main IG', '@main_brand'),
           ('acct_tt_1', ${orgA}, ${brandA}, 'tiktok', 'ext_tt_1', 'Main TikTok', '@main_tiktok')
  `;

  // 1. Schedule across both accounts simultaneously
  const scheduled = await scheduleMultiAccountPublish(sql, {
    organizationId: orgA,
    brandId: brandA,
    creativeId: "variant_xyz",
    targetAccountIds: ["acct_ig_1", "acct_tt_1"],
    targetType: "organic",
  });

  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[0].status, "queued");
  assert.equal(scheduled[1].status, "queued");

  // 2. Idempotency test: Re-scheduling with identical input returns same records without creating duplicate rows
  const reScheduled = await scheduleMultiAccountPublish(sql, {
    organizationId: orgA,
    brandId: brandA,
    creativeId: "variant_xyz",
    targetAccountIds: ["acct_ig_1", "acct_tt_1"],
    targetType: "organic",
  });

  assert.equal(reScheduled.length, 2);
  const queueItems = await listBrandPublishingQueue(sql, orgA, brandA);
  assert.equal(queueItems.length, 2, "Duplicate rows must not be inserted");

  // 3. Worker atomic claim: claims queued jobs
  const claimed = await claimScheduledJobs(sql, 10);
  assert.equal(claimed.length, 2);
  assert.equal(claimed[0].status, "processing");

  // Concurrent worker call claims 0 (already in processing)
  const emptyClaim = await claimScheduledJobs(sql, 10);
  assert.equal(emptyClaim.length, 0);

  // 4. Record success for first job
  const receipt = await recordPublishSuccess(sql, claimed[0].id, {
    organizationId: orgA,
    brandId: brandA,
    platform: claimed[0].platform,
    accountId: claimed[0].targetAccountId,
    externalPostId: "ext_ig_post_999",
    externalUrl: "https://instagram.com/p/ext_ig_post_999",
  });

  assert.ok(receipt.id);
  assert.equal(receipt.externalPostId, "ext_ig_post_999");
  assert.equal(receipt.status, "live");

  const receipts = await listBrandPublishingReceipts(sql, orgA, brandA);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].externalPostId, "ext_ig_post_999");

  // 5. Record failure for second job (attempt 1) -> exponential backoff
  const failResult = await recordPublishFailure(sql, claimed[1].id, "API timeout on video upload");
  assert.equal(failResult.willRetry, true);
  assert.ok(failResult.nextRetryAt);

  // 6. Test cancellation & retry
  const cancelled = await cancelPublishJob(sql, orgA, brandA, claimed[1].id);
  assert.equal(cancelled, true);

  const retried = await retryPublishJob(sql, orgA, brandA, claimed[1].id);
  assert.equal(retried, true);

  // 7. Tenant isolation: Org B sees 0 queue items and 0 receipts
  const queueB = await listBrandPublishingQueue(sql, orgB, brandB);
  assert.equal(queueB.length, 0);

  const receiptsB = await listBrandPublishingReceipts(sql, orgB, brandB);
  assert.equal(receiptsB.length, 0);
});
