/**
 * Durable Crawl Frontier & Lease Management
 *
 * Implements Sections P1.7, P1.8, P1.9, and P1.10 of Meridian Hardening:
 * - Durable Postgres frontier state (replacing volatile in-memory queues)
 * - Atomic worker claiming with leases and heartbeats (SKIP LOCKED)
 * - Automatic crash recovery and deterministic exponential retry backoff
 * - Transactional frontier expansion upon link extraction
 */

import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";

export const FrontierStatus = {
  PENDING: "PENDING",
  LEASED: "LEASED",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  RETRY: "RETRY",
  BLOCKED: "BLOCKED",
} as const;

export type FrontierStatus = (typeof FrontierStatus)[keyof typeof FrontierStatus];

export interface CrawlerRetryPolicy {
  maxAttempts: number;
  backoffSeconds: number[];
}

export const DEFAULT_CRAWLER_RETRY_POLICY: CrawlerRetryPolicy = {
  maxAttempts: 5,
  backoffSeconds: [30, 120, 600, 3600], // 30s, 2m, 10m, 1h
};

export interface FrontierRecord {
  id: string;
  organizationId: string;
  brandId: string;
  runId: string;
  url: string;
  canonicalUrl?: string | null;
  depth: number;
  parentUrl?: string | null;
  status: FrontierStatus;
  priority: number;
  attempts: number;
  leaseOwner?: string | null;
  leaseExpiresAt?: Date | string | null;
  discoveredAt: Date | string;
  startedAt?: Date | string | null;
  completedAt?: Date | string | null;
  nextAttemptAt?: Date | string | null;
  lastError?: string | null;
}

export class DiscoveryFrontierService {
  /**
   * Adds initial seeds or discovered links to the durable frontier.
   */
  static async enqueueLinks(
    sql: Sql,
    options: {
      organizationId: string;
      brandId: string;
      runId: string;
      links: Array<{
        url: string;
        canonicalUrl?: string;
        depth?: number;
        parentUrl?: string;
        priority?: number;
      }>;
    }
  ): Promise<number> {
    if (options.links.length === 0) return 0;

    let inserted = 0;
    for (const link of options.links) {
      const id = `front_${randomUUID()}`;
      const depth = link.depth ?? 0;
      const priority = link.priority ?? 0;

      const rows = await sql`
        insert into discovery_frontier (
          id, organization_id, brand_id, run_id, url, canonical_url,
          depth, parent_url, status, priority, attempts, discovered_at
        )
        select
          ${id}, ${options.organizationId}, ${options.brandId}, ${options.runId},
          ${link.url}, ${link.canonicalUrl || null}, ${depth}, ${link.parentUrl || null},
          'PENDING', ${priority}, 0, now()
        where not exists (
          select 1 from discovery_frontier
          where run_id = ${options.runId} and url = ${link.url}
        )
        on conflict (run_id, url) do nothing
        returning id
      `;

      if (rows.length > 0) {
        inserted++;
      }
    }

    return inserted;
  }

  /**
   * Claims a frontier item using row locking (FOR UPDATE SKIP LOCKED) with a lease.
   */
  static async claimNextItem(
    sql: Sql,
    options: {
      organizationId: string;
      brandId: string;
      runId?: string;
      workerId: string;
      leaseSeconds?: number;
    }
  ): Promise<FrontierRecord | null> {
    const leaseSeconds = options.leaseSeconds ?? 60;

    const rows = options.runId
      ? await sql<Record<string, unknown>>`
          with candidate as (
            select id
            from discovery_frontier
            where organization_id = ${options.organizationId}
              and brand_id = ${options.brandId}
              and run_id = ${options.runId}
              and (
                status = 'PENDING'
                or (status = 'RETRY' and (next_attempt_at is null or next_attempt_at <= now()))
                or (status in ('LEASED', 'PROCESSING') and lease_expires_at < now())
              )
            order by priority desc, discovered_at asc
            for update skip locked
            limit 1
          )
          update discovery_frontier f
          set
            status = 'LEASED',
            lease_owner = ${options.workerId},
            lease_expires_at = now() + (${leaseSeconds} || ' seconds')::interval,
            attempts = f.attempts + 1,
            started_at = coalesce(f.started_at, now())
          from candidate c
          where f.id = c.id
          returning f.*
        `
      : await sql<Record<string, unknown>>`
          with candidate as (
            select id
            from discovery_frontier
            where organization_id = ${options.organizationId}
              and brand_id = ${options.brandId}
              and (
                status = 'PENDING'
                or (status = 'RETRY' and (next_attempt_at is null or next_attempt_at <= now()))
                or (status in ('LEASED', 'PROCESSING') and lease_expires_at < now())
              )
            order by priority desc, discovered_at asc
            for update skip locked
            limit 1
          )
          update discovery_frontier f
          set
            status = 'LEASED',
            lease_owner = ${options.workerId},
            lease_expires_at = now() + (${leaseSeconds} || ' seconds')::interval,
            attempts = f.attempts + 1,
            started_at = coalesce(f.started_at, now())
          from candidate c
          where f.id = c.id
          returning f.*
        `;

    const row = rows[0];
    if (!row) return null;

    return this.mapRow(row);
  }

  /**
   * Heartbeat to extend lease during long-running page operations.
   */
  static async heartbeat(
    sql: Sql,
    options: {
      itemId: string;
      workerId: string;
      organizationId: string;
      brandId: string;
      runId: string;
      leaseSeconds?: number;
    }
  ): Promise<boolean> {
    const leaseSeconds = options.leaseSeconds ?? 60;
    const rows = await sql`
      update discovery_frontier
      set lease_expires_at = now() + (${leaseSeconds} || ' seconds')::interval
      where id = ${options.itemId}
        and organization_id = ${options.organizationId}
        and brand_id = ${options.brandId}
        and run_id = ${options.runId}
        and lease_owner = ${options.workerId}
        and status in ('LEASED', 'PROCESSING')
        and lease_expires_at > now()
      returning id
    `;
    return rows.length > 0;
  }

  /**
   * Transition item to PROCESSING state once worker begins active extraction.
   */
  static async markProcessing(
    sql: Sql,
    options: {
      itemId: string;
      workerId: string;
      organizationId: string;
      brandId: string;
      runId: string;
    }
  ): Promise<boolean> {
    const rows = await sql`
      update discovery_frontier
      set status = 'PROCESSING'
      where id = ${options.itemId}
        and organization_id = ${options.organizationId}
        and brand_id = ${options.brandId}
        and run_id = ${options.runId}
        and lease_owner = ${options.workerId}
        and status = 'LEASED'
        and lease_expires_at > now()
      returning id
    `;
    return rows.length > 0;
  }

  /**
   * Completes a frontier item and transactionally expands newly discovered links.
   */
  static async completeItem(
    sql: Sql,
    options: {
      itemId: string;
      workerId: string;
      organizationId: string;
      brandId: string;
      runId: string;
      currentDepth: number;
      maxDepth?: number;
      discoveredLinks?: string[];
    }
  ): Promise<void> {
    const maxDepth = options.maxDepth ?? 3;
    const links = options.currentDepth < maxDepth
      ? [...new Set(options.discoveredLinks || [])].map((url) => ({ url, depth: options.currentDepth + 1 }))
      : [];
    const completed = await sql<{ id: string }>`
      with completed as (
        update discovery_frontier
        set status = 'COMPLETED', completed_at = now(), lease_owner = null, lease_expires_at = null
        where id = ${options.itemId} and organization_id = ${options.organizationId}
          and brand_id = ${options.brandId} and run_id = ${options.runId}
          and lease_owner = ${options.workerId} and status in ('LEASED', 'PROCESSING')
          and lease_expires_at > now()
        returning id, organization_id, brand_id, run_id
      ), expanded as (
        insert into discovery_frontier (
          id, organization_id, brand_id, run_id, url, canonical_url, depth, parent_url, status, priority, attempts, discovered_at
        )
        select 'front_' || md5(c.run_id || ':' || l.url), c.organization_id, c.brand_id, c.run_id,
          l.url, l.url, l.depth, ${options.itemId}, 'PENDING', 0, 0, now()
        from completed c
        cross join jsonb_to_recordset(${JSON.stringify(links)}::jsonb) as l(url text, depth integer)
        on conflict (run_id, url) do nothing
        returning id
      )
      select id from completed
    `;
    if (completed.length === 0) throw new Error("Discovery frontier completion lost its lease or tenant scope.");
  }

  /**
   * Marks item for retry or permanent failure based on attempt count and backoff policy.
   */
  static async failItem(
    sql: Sql,
    options: {
      itemId: string;
      workerId: string;
      organizationId: string;
      brandId: string;
      runId: string;
      error: string;
      policy?: CrawlerRetryPolicy;
    }
  ): Promise<FrontierStatus> {
    const policy = options.policy ?? DEFAULT_CRAWLER_RETRY_POLICY;

    const rows = await sql<Record<string, unknown>>`
      select attempts from discovery_frontier
      where id = ${options.itemId} and organization_id = ${options.organizationId}
        and brand_id = ${options.brandId} and run_id = ${options.runId}
        and lease_owner = ${options.workerId} and status in ('LEASED', 'PROCESSING')
        and lease_expires_at > now()
    `;
    if (rows.length === 0) throw new Error("Discovery frontier item is no longer leased to this worker.");
    const attempts = Number(rows[0]?.attempts || 1);

    if (attempts >= policy.maxAttempts) {
      const changed = await sql`
        update discovery_frontier
        set
          status = 'FAILED',
          last_error = ${options.error},
          lease_owner = null,
          lease_expires_at = null,
          completed_at = now()
        where id = ${options.itemId} and organization_id = ${options.organizationId}
          and brand_id = ${options.brandId} and run_id = ${options.runId} and lease_owner = ${options.workerId}
          and status in ('LEASED', 'PROCESSING') and lease_expires_at > now()
        returning id
      `;
      if (changed.length === 0) throw new Error("Discovery frontier lease changed before failure was recorded.");
      return "FAILED";
    }

    const backoffSeconds = policy.backoffSeconds[Math.min(attempts - 1, policy.backoffSeconds.length - 1)] ?? 60;

    const changed = await sql`
      update discovery_frontier
      set
        status = 'RETRY',
        last_error = ${options.error},
        next_attempt_at = now() + (${backoffSeconds} || ' seconds')::interval,
        lease_owner = null,
        lease_expires_at = null
      where id = ${options.itemId} and organization_id = ${options.organizationId}
        and brand_id = ${options.brandId} and run_id = ${options.runId} and lease_owner = ${options.workerId}
        and status in ('LEASED', 'PROCESSING')
      returning id
    `;
    if (changed.length === 0) throw new Error("Discovery frontier lease changed before retry was recorded.");
    return "RETRY";
  }

  /**
   * Recovers stale discovery work (crashed workers / expired leases).
   * Called on worker/system startup or periodic health checks.
   */
  static async recoverStaleDiscoveryWork(
    sql: Sql,
    options: {
      organizationId: string;
      brandId: string;
      policy?: CrawlerRetryPolicy;
    }
  ): Promise<{ recoveredCount: number; failedCount: number }> {
    const policy = options.policy ?? DEFAULT_CRAWLER_RETRY_POLICY;

    const staleRows = await sql<Record<string, unknown>>`
          select id, attempts from discovery_frontier
          where organization_id = ${options.organizationId}
            and brand_id = ${options.brandId}
            and status in ('LEASED', 'PROCESSING')
            and lease_expires_at < now()
        `

    let recoveredCount = 0;
    let failedCount = 0;

    for (const row of staleRows) {
      const id = String(row.id);
      const attempts = Number(row.attempts || 1);

      if (attempts >= policy.maxAttempts) {
        const changed = await sql`
          update discovery_frontier
          set
            status = 'FAILED',
            last_error = 'Lease expired and max attempts reached (worker crashed)',
            lease_owner = null,
            lease_expires_at = null,
            completed_at = now()
          where id = ${id} and organization_id = ${options.organizationId} and brand_id = ${options.brandId}
            and status in ('LEASED', 'PROCESSING') and lease_expires_at < now()
          returning id
        `;
        if (changed.length > 0) failedCount++;
      } else {
        const backoffSeconds = policy.backoffSeconds[Math.min(attempts - 1, policy.backoffSeconds.length - 1)] ?? 30;
        const changed = await sql`
          update discovery_frontier
          set
            status = 'RETRY',
            last_error = 'Lease expired (worker abandoned or crashed)',
            next_attempt_at = now() + (${backoffSeconds} || ' seconds')::interval,
            lease_owner = null,
            lease_expires_at = null
          where id = ${id} and organization_id = ${options.organizationId} and brand_id = ${options.brandId}
            and status in ('LEASED', 'PROCESSING') and lease_expires_at < now()
          returning id
        `;
        if (changed.length > 0) recoveredCount++;
      }
    }

    return { recoveredCount, failedCount };
  }

  private static mapRow(row: Record<string, unknown>): FrontierRecord {
    return {
      id: String(row.id),
      organizationId: String(row.organization_id),
      brandId: String(row.brand_id),
      runId: String(row.run_id),
      url: String(row.url),
      canonicalUrl: row.canonical_url ? String(row.canonical_url) : null,
      depth: Number(row.depth || 0),
      parentUrl: row.parent_url ? String(row.parent_url) : null,
      status: row.status as FrontierStatus,
      priority: Number(row.priority || 0),
      attempts: Number(row.attempts || 0),
      leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
      leaseExpiresAt: row.lease_expires_at ? (row.lease_expires_at as Date | string) : null,
      discoveredAt: row.discovered_at as Date | string,
      startedAt: row.started_at ? (row.started_at as Date | string) : null,
      completedAt: row.completed_at ? (row.completed_at as Date | string) : null,
      nextAttemptAt: row.next_attempt_at ? (row.next_attempt_at as Date | string) : null,
      lastError: row.last_error ? String(row.last_error) : null,
    };
  }
}
