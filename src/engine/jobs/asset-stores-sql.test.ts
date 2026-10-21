import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { budgetReservationSchema, EngineError } from "../contracts/index.ts";
import { FIXTURE_IDS, fixtureId } from "../contracts/fixtures/index.ts";
import { paidCall, type LockableLedger } from "../gateway/paid.ts";
import { createGateway } from "../gateway/gateway.ts";
import { recorded, staticKeys } from "../gateway/test/recorded.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { startEngineRequest } from "./orchestrator-sql.ts";
import { sqlLedgerStore } from "./sql-ledger-store.ts";
import { scopedLedgerStore, sqlAssetCache, sqlBreakerStore, sqlBucketStore, sqlProviderStats } from "./asset-stores-sql.ts";
import type { CachedAsset } from "../assets/cache.ts";

let db: TestDatabase;

const A = "org_stores_a";
const B = "org_stores_b";
const REQUEST = FIXTURE_IDS.request;
const RESERVATION = fixtureId("res_", 88);
const NOW = "2026-10-14T10:00:00.000Z";
const CACHE_KEY = `sha256:${"b".repeat(64)}`;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, A, "brand_stores_a");
  await seedWorkspace(db.sql, B, "brand_stores_b");
  await startEngineRequest(db.sql, {
    organizationId: A,
    brandId: "brand_stores_a",
    requestId: REQUEST,
    formatId: "fmt_stores",
    priority: "normal",
    cachedDna: true,
    variantCount: 0,
    requestArtifactId: fixtureId("art_", 601),
  });
  await sqlLedgerStore(db.sql, A).createReservation(
    budgetReservationSchema.parse({
      schema: "meridian.budget_reservation/v1",
      reservationId: RESERVATION,
      requestId: REQUEST,
      workspaceId: A,
      mode: "cap",
      lines: [{ stage: "produce_shot", estimateUsd: 1 }],
      estimateUsd: 1,
      redoAllowanceUsd: 0,
      reservedUsd: 1,
      state: "reserved",
      createdAt: NOW,
    }),
  );
});

after(async () => {
  await db.close();
});

test("provider attempts are read back in the order they were recorded, and never across workspaces", async () => {
  const stats = sqlProviderStats(db.sql, A);
  await stats.record({ providerId: "openrouter:kling", atMs: 1000, outcome: "success", latencyMs: 2500, errorKind: null });
  await stats.record({ providerId: "openrouter:kling", atMs: 2000, outcome: "provider_failure", latencyMs: null, errorKind: "server" });
  await stats.record({ providerId: "openrouter:kling", atMs: 500, outcome: "request_refused", latencyMs: null, errorKind: "content_policy" });

  const since = await stats.since("openrouter:kling", 900);
  assert.deepEqual(
    since.map((record) => [record.atMs, record.outcome, record.latencyMs]),
    [
      [1000, "success", 2500],
      [2000, "provider_failure", null],
    ],
    "the window filters by time and keeps the recording order (the refused record at 500 is outside it)",
  );
  assert.deepEqual(await sqlProviderStats(db.sql, B).since("openrouter:kling", 0), [], "another workspace sees none of this history");
});

test("the circuit breaker state is per workspace and is replaced by a later trip", async () => {
  const breakers = sqlBreakerStore(db.sql, A);
  assert.equal(await breakers.get("openrouter:kling"), null);
  await breakers.set("openrouter:kling", { trippedAtMs: 1000, openUntilMs: 601_000 });
  await breakers.set("openrouter:kling", { trippedAtMs: 700_000, openUntilMs: 1_300_000 });
  assert.deepEqual(await breakers.get("openrouter:kling"), { trippedAtMs: 700_000, openUntilMs: 1_300_000 });
  assert.equal(await sqlBreakerStore(db.sql, B).get("openrouter:kling"), null, "another workspace's breaker is closed");
});

test("a bucket holds at most its limit, a released slot is free again, and an expired slot does not count", async () => {
  const buckets = sqlBucketStore(db.sql, A, 60_000);
  assert.equal(await buckets.tryAcquire("video", 2), true);
  assert.equal(await buckets.tryAcquire("video", 2), true);
  assert.equal(await buckets.tryAcquire("video", 2), false, "a full bucket takes nothing");
  assert.equal(await buckets.inFlight("video"), 2);

  await buckets.release("video");
  assert.equal(await buckets.tryAcquire("video", 2), true, "a released slot can be taken");

  // A worker that died holds its slot until the lease expires. Expire every lease of this bucket, and the slots are free.
  await db.sql`update engine_bucket_leases set expires_at = now() - interval '1 second' where organization_id = ${A} and bucket_id = 'video'`;
  assert.equal(await buckets.inFlight("video"), 0);
  assert.equal(await buckets.tryAcquire("video", 1), true, "an expired lease does not hold the bucket");
  assert.equal(await sqlBucketStore(db.sql, B).tryAcquire("video", 1), true, "another workspace's bucket is its own");
});

test("a bucket limit below one is refused, not treated as unlimited", async () => {
  await assert.rejects(sqlBucketStore(db.sql, A).tryAcquire("video", 0), (error: unknown) => error instanceof EngineError && error.kind === "config");
});

function cached(workspaceId: string, uri = "https://provider.example/clip.mp4"): CachedAsset {
  return {
    workspaceId,
    cacheKey: CACHE_KEY,
    providerId: "openrouter:kling",
    modelClass: "video.cinematic",
    uri,
    costUsd: 0.6125,
    mediaType: "video/mp4",
    storedAt: NOW,
  };
}

test("the asset cache keeps the first write, returns it on a hit, and records each hit against its request", async () => {
  const cache = sqlAssetCache(db.sql, A);
  assert.equal(await cache.get(A, CACHE_KEY), null);
  const first = await cache.put(cached(A));
  assert.equal(first.uri, "https://provider.example/clip.mp4");
  const second = await cache.put(cached(A, "https://provider.example/other.mp4"));
  assert.equal(second.uri, first.uri, "the first write wins: a stored asset is never replaced");

  const hit = await cache.get(A, CACHE_KEY);
  assert.equal(hit?.costUsd, 0.6125);
  await cache.recordHit({ workspaceId: A, cacheKey: CACHE_KEY, providerId: "openrouter:kling", requestId: REQUEST, shotId: FIXTURE_IDS.shot3, at: NOW, savedUsd: 0.6125 });
  const hits = await cache.hits(A);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.savedUsd, 0.6125);
});

test("the asset cache is per workspace: another workspace misses, and cannot write or read through this one", async () => {
  assert.equal(await sqlAssetCache(db.sql, B).get(B, CACHE_KEY), null, "the same key is a miss in another workspace");
  await assert.rejects(sqlAssetCache(db.sql, A).put(cached(B)), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  await assert.rejects(sqlAssetCache(db.sql, A).get(B, CACHE_KEY), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
});

test("a budget step for a reservation runs under its lock, and a paid call through it is authorized and reconciled", async () => {
  const ledger = scopedLedgerStore(db.sql, A, RESERVATION);
  let locks = 0;
  const counting: LockableLedger = {
    ...ledger,
    withLock: (fn) => {
      locks += 1;
      return ledger.withLock!(fn);
    },
  };
  const gateway = createGateway({ transport: recorded([]).transport, credentials: staticKeys({}) });
  const route = gateway.chosen("video.cinematic", "kwaivgi/kling-v3.0-std");
  const outcome = await paidCall(
    { ledger: counting, reservationId: RESERVATION, stage: "produce_shot", route, estimateUsd: 0.63, idempotencyKey: `${CACHE_KEY}-locked`, at: NOW },
    async () => ({ value: "uri", actualUsd: 0.6125 }),
  );
  assert.equal(outcome.status, "done");
  assert.equal(locks, 2, "authorize and reconcile each run under the reservation's lock");
  const entry = await ledger.getEntryByKey(`${CACHE_KEY}-locked`);
  assert.equal(entry?.actualUsd, 0.6125);
  assert.equal(entry?.settlement, "billed");
});

test("a call that exceeds the reservation in cap mode is refused under the lock, and nothing is written", async () => {
  const ledger = scopedLedgerStore(db.sql, A, RESERVATION);
  const gateway = createGateway({ transport: recorded([]).transport, credentials: staticKeys({}) });
  let ran = false;
  const outcome = await paidCall(
    { ledger, reservationId: RESERVATION, stage: "produce_shot", route: gateway.chosen("video.cinematic", "kwaivgi/kling-v3.0-std"), estimateUsd: 5, idempotencyKey: `${CACHE_KEY}-too-big`, at: NOW },
    async () => {
      ran = true;
      return { value: "never", actualUsd: 5 };
    },
  );
  assert.equal(outcome.status, "refused");
  assert.equal(ran, false, "a refused call is never made");
  assert.equal(await ledger.getEntryByKey(`${CACHE_KEY}-too-big`), null);
});
