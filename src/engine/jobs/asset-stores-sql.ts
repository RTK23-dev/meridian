// Postgres implementations of the asset router's stores (Video Engine Bible 10.2 and 10.4): the attempt history that scores
// providers, the circuit breaker, the concurrency buckets and the asset cache. Each is bound to one organization, so every row
// is read and written inside its tenant. A ledger for one reservation is also here: its budget steps run under the reservation's
// row lock (gateway/paid.ts, budget README).
//
// Every store takes the Sql handle it is given. The router calls them outside any transaction, so each call is its own
// statement or its own short transaction. No provider call is ever made inside a transaction.

import { randomUUID } from "node:crypto";
import { EngineError, roundUsd } from "../contracts/index.ts";
import { thresholds } from "../config/thresholds.ts";
import type { LockableLedger } from "../gateway/paid.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { AttemptOutcome, AttemptRecord, ProviderStats } from "../assets/stats.ts";
import type { BreakerState, BreakerStore } from "../assets/breaker.ts";
import type { BucketStore } from "../assets/buckets.ts";
import type { AssetCache, CacheHit, CachedAsset } from "../assets/cache.ts";
import type { ProviderErrorKind } from "../assets/classify.ts";
import { sqlLedgerStore, withReservationLedger } from "./sql-ledger-store.ts";
import { transaction } from "./orchestrator-sql.ts";

/** How long a bucket slot stays held before it expires: the generation lease class (Bible 5.1). */
export const BUCKET_LEASE_MS = thresholds.jobs.leaseMs.generation;

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function requireOrganization(organizationId: string): void {
  if (organizationId.length === 0) {
    throw new EngineError("invalid_input", "an asset store needs the organization it serves");
  }
}

/** The attempt history of one organization. Read by scoring (the reliability and latency dimensions) and by the breaker. */
export function sqlProviderStats(sql: Sql, organizationId: string): ProviderStats {
  requireOrganization(organizationId);
  return {
    async record(record: AttemptRecord): Promise<void> {
      await sql`
        insert into engine_provider_attempts (id, organization_id, provider_id, at_ms, outcome, latency_ms, error_kind)
        values (${randomUUID()}, ${organizationId}, ${record.providerId}, ${record.atMs}, ${record.outcome},
          ${record.latencyMs}, ${record.errorKind})
      `;
    },
    async since(providerId: string, sinceMs: number): Promise<AttemptRecord[]> {
      const rows = await sql<{
        provider_id: string;
        at_ms: unknown;
        outcome: AttemptOutcome;
        latency_ms: unknown;
        error_kind: ProviderErrorKind | null;
      }>`
        select provider_id, at_ms, outcome, latency_ms, error_kind from engine_provider_attempts
        where organization_id = ${organizationId} and provider_id = ${providerId} and at_ms >= ${sinceMs}
        order by seq asc
      `;
      return rows.map((row) => ({
        providerId: row.provider_id,
        atMs: Number(row.at_ms),
        outcome: row.outcome,
        latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
        errorKind: row.error_kind,
      }));
    },
  };
}

/** The circuit breaker state of one organization's providers (Bible 10.4). */
export function sqlBreakerStore(sql: Sql, organizationId: string): BreakerStore {
  requireOrganization(organizationId);
  return {
    async get(providerId: string): Promise<BreakerState | null> {
      const rows = await sql<{ tripped_at_ms: unknown; open_until_ms: unknown }>`
        select tripped_at_ms, open_until_ms from engine_provider_breakers
        where organization_id = ${organizationId} and provider_id = ${providerId} limit 1
      `;
      const row = rows[0];
      return row ? { trippedAtMs: Number(row.tripped_at_ms), openUntilMs: Number(row.open_until_ms) } : null;
    },
    async set(providerId: string, state: BreakerState): Promise<void> {
      await sql`
        insert into engine_provider_breakers (organization_id, provider_id, tripped_at_ms, open_until_ms)
        values (${organizationId}, ${providerId}, ${state.trippedAtMs}, ${state.openUntilMs})
        on conflict (organization_id, provider_id) do update
          set tripped_at_ms = excluded.tripped_at_ms, open_until_ms = excluded.open_until_ms, updated_at = now()
      `;
    },
  };
}

/**
 * The concurrency buckets of one organization. A slot is a lease row that expires. Taking a slot locks the bucket's row, so two
 * workers cannot both take the last slot, and a full bucket returns false without writing anything.
 */
export function sqlBucketStore(sql: Sql, organizationId: string, leaseMs: number = BUCKET_LEASE_MS): BucketStore {
  requireOrganization(organizationId);
  return {
    async tryAcquire(bucketId: string, limit: number): Promise<boolean> {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new EngineError("config", `bucket ${bucketId} needs a whole-number limit of at least 1`);
      }
      return transaction(sql, async (tx) => {
        await tx`insert into engine_buckets (organization_id, bucket_id) values (${organizationId}, ${bucketId}) on conflict do nothing`;
        await tx`select bucket_id from engine_buckets where organization_id = ${organizationId} and bucket_id = ${bucketId} for update`;
        await tx`
          delete from engine_bucket_leases
          where organization_id = ${organizationId} and bucket_id = ${bucketId} and expires_at <= now()
        `;
        const counted = await tx<{ n: unknown }>`
          select count(*) as n from engine_bucket_leases where organization_id = ${organizationId} and bucket_id = ${bucketId}
        `;
        if (Number(counted[0]?.n ?? 0) >= limit) return false;
        await tx`
          insert into engine_bucket_leases (id, organization_id, bucket_id, expires_at)
          values (${randomUUID()}, ${organizationId}, ${bucketId}, now() + (${leaseMs}::int * interval '1 millisecond'))
        `;
        return true;
      });
    },
    async release(bucketId: string): Promise<void> {
      await sql`
        delete from engine_bucket_leases where id = (
          select id from engine_bucket_leases
          where organization_id = ${organizationId} and bucket_id = ${bucketId}
          order by expires_at asc limit 1
        )
      `;
    },
    async inFlight(bucketId: string): Promise<number> {
      const rows = await sql<{ n: unknown }>`
        select count(*) as n from engine_bucket_leases
        where organization_id = ${organizationId} and bucket_id = ${bucketId} and expires_at > now()
      `;
      return Number(rows[0]?.n ?? 0);
    },
  };
}

type CacheRow = {
  organization_id: string;
  cache_key: string;
  provider_id: string;
  model_class: string;
  uri: string;
  cost_usd: unknown;
  media_type: string | null;
  stored_at: unknown;
};

function cacheRowToAsset(row: CacheRow): CachedAsset {
  return {
    workspaceId: row.organization_id,
    cacheKey: row.cache_key,
    providerId: row.provider_id,
    modelClass: row.model_class,
    uri: row.uri,
    costUsd: Number(row.cost_usd),
    mediaType: row.media_type,
    storedAt: toIso(row.stored_at),
  };
}

/** The asset cache of one organization (Bible 10.4). A hit is recorded against its request, with the cost it saved. */
export function sqlAssetCache(sql: Sql, organizationId: string): AssetCache {
  requireOrganization(organizationId);
  const sameWorkspace = (workspaceId: string): void => {
    if (workspaceId !== organizationId) {
      throw new EngineError("invalid_input", "an asset cache entry belongs to another workspace (tenant scope violation)");
    }
  };
  return {
    async get(workspaceId, cacheKey) {
      sameWorkspace(workspaceId);
      const rows = await sql<CacheRow>`
        select organization_id, cache_key, provider_id, model_class, uri, cost_usd, media_type, stored_at
        from engine_asset_cache where organization_id = ${organizationId} and cache_key = ${cacheKey} limit 1
      `;
      return rows[0] ? cacheRowToAsset(rows[0]) : null;
    },
    async put(asset) {
      sameWorkspace(asset.workspaceId);
      const cost = roundUsd(asset.costUsd);
      await sql`
        insert into engine_asset_cache (organization_id, cache_key, provider_id, model_class, uri, cost_usd, media_type, stored_at)
        values (${organizationId}, ${asset.cacheKey}, ${asset.providerId}, ${asset.modelClass}, ${asset.uri}, ${cost},
          ${asset.mediaType}, ${asset.storedAt})
        on conflict (organization_id, cache_key) do nothing
      `;
      const rows = await sql<CacheRow>`
        select organization_id, cache_key, provider_id, model_class, uri, cost_usd, media_type, stored_at
        from engine_asset_cache where organization_id = ${organizationId} and cache_key = ${asset.cacheKey} limit 1
      `;
      const stored = rows[0];
      if (!stored) throw new EngineError("internal", "the asset cache entry was not stored");
      return cacheRowToAsset(stored);
    },
    async recordHit(hit: CacheHit) {
      sameWorkspace(hit.workspaceId);
      await sql`
        insert into engine_asset_cache_hits (id, organization_id, request_id, cache_key, provider_id, shot_id, saved_usd, at)
        values (${randomUUID()}, ${organizationId}, ${hit.requestId}, ${hit.cacheKey}, ${hit.providerId}, ${hit.shotId},
          ${roundUsd(hit.savedUsd)}, ${hit.at})
      `;
    },
    async hits(workspaceId) {
      sameWorkspace(workspaceId);
      const rows = await sql<{
        request_id: string;
        cache_key: string;
        provider_id: string;
        shot_id: string;
        saved_usd: unknown;
        at: unknown;
      }>`
        select request_id, cache_key, provider_id, shot_id, saved_usd, at from engine_asset_cache_hits
        where organization_id = ${organizationId} order by at asc, id asc
      `;
      return rows.map((row) => ({
        workspaceId: organizationId,
        cacheKey: row.cache_key,
        providerId: row.provider_id,
        requestId: row.request_id,
        shotId: row.shot_id,
        at: toIso(row.at),
        savedUsd: Number(row.saved_usd),
      }));
    },
  };
}

/**
 * The budget ledger for one reservation. Its reads are plain; its budget steps (authorize, reconcile) run through withLock, which
 * takes the reservation's row lock in one transaction. Pass it as the router's ledger and the paid calls are serialized per
 * reservation, so concurrent shots of one request cannot both pass the same remaining budget.
 */
export function scopedLedgerStore(sql: Sql, organizationId: string, reservationId: string): LockableLedger {
  requireOrganization(organizationId);
  const store = sqlLedgerStore(sql, organizationId);
  return Object.assign(store, {
    withLock: <T>(fn: (locked: typeof store) => Promise<T>): Promise<T> =>
      withReservationLedger(sql, organizationId, reservationId, (locked) => fn(locked)),
  });
}
