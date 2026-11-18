/**
 * Readiness for uptime monitors and load balancers. Liveness stays where it is: `GET /api/health` answers `{ status: "ok" }` with no
 * dependency (observability/health.ts). Readiness says whether this instance can do its work now:
 *
 *   database    a `select 1` answers within READINESS_TIMEOUT_MS (2 s)
 *   migrations  every file in migrations/ is recorded in `_migrations` (the same rule as scripts/migrate.mjs)
 *   jobs        the oldest job that is due and runnable (the worker's own pick rule, jobs/sql-worker.ts) became due less than
 *               READINESS_MAX_DUE_JOB_AGE_MS ago. An older one means no worker is taking jobs.
 *
 * The answer is 200 when every check is ok, else 503. The body names each check and its state, and nothing else: no counts (nothing is
 * summed across workspaces), no host names, no error text, no stack. A check that cannot be read is "unknown", which is not ready.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pendingMigrations } from "../../../../scripts/migration-plan.mjs";
import type { Sql } from "../learning/store.ts";

export const READINESS_TIMEOUT_MS = 2_000;
/** A due job older than this means the queue is stalled. The worker polls every few seconds, so fifteen minutes is far past normal. */
export const READINESS_MAX_DUE_JOB_AGE_MS = 15 * 60_000;

export type CheckState = "ok" | "fail" | "pending" | "stalled" | "unknown";
export type ReadinessBody = {
  status: "ready" | "not_ready";
  checks: { database: CheckState; migrations: CheckState; jobs: CheckState };
};
export type ReadinessResult = { status: 200 | 503; body: ReadinessBody };

export type ReadinessDeps = {
  /** Opens the database. A rejection or a timeout is "fail". */
  sql: () => Promise<Sql>;
  /** The migration file names in migrations/, or null when the folder cannot be read. */
  migrationFiles: () => string[] | null;
  timeoutMs?: number;
  maxDueJobAgeMs?: number;
};

class TimedOut extends Error {}

/** Resolves with the promise's value, or rejects with TimedOut after `ms`. The timer is cleared as soon as the promise settles. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimedOut(`timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** The migration files in a folder, by the migrator's own rule (non-recursive, .sql only). Null when the folder cannot be read. */
export function migrationFilesIn(dir: string = join(process.cwd(), "migrations")): string[] | null {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".sql"));
  } catch {
    return null;
  }
}

/** Seconds as a number from a driver value (number, numeric string or bigint), or null when it is not one. */
function seconds(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Runs the three checks. Never throws: a check that fails to run is "fail" or "unknown". */
export async function checkReadiness(deps: ReadinessDeps): Promise<ReadinessResult> {
  const timeoutMs = deps.timeoutMs ?? READINESS_TIMEOUT_MS;
  const maxAgeMs = deps.maxDueJobAgeMs ?? READINESS_MAX_DUE_JOB_AGE_MS;
  const checks: ReadinessBody["checks"] = { database: "unknown", migrations: "unknown", jobs: "unknown" };

  let sql: Sql | null = null;
  try {
    sql = await withTimeout(deps.sql(), timeoutMs);
    await withTimeout(sql`select 1 as ok`, timeoutMs);
    checks.database = "ok";
  } catch {
    checks.database = "fail";
  }

  if (sql && checks.database === "ok") {
    const files = deps.migrationFiles();
    if (files && files.length > 0) {
      try {
        const applied = await withTimeout(sql<{ name: string }>`select name from _migrations`, timeoutMs);
        checks.migrations = pendingMigrations(files, applied.map((row) => String(row.name))).length === 0 ? "ok" : "pending";
      } catch {
        checks.migrations = "unknown";
      }
    }

    try {
      // The worker's own pick rule: queued or retrying, due, not cancelled, and its dependency (if any) has succeeded. The age is
      // measured on the database clock, so a skewed app clock cannot hide a stall.
      const rows = await withTimeout(
        sql<{ age_seconds: unknown }>`
          select extract(epoch from (now() - min(run_after)))::float8 as age_seconds
          from jobs
          where status in ('queued', 'retry')
            and run_after <= now()
            and cancel_requested = false
            and (depends_on = '' or exists (
              select 1 from jobs parent where parent.id = jobs.depends_on and parent.status = 'succeeded'
            ))
        `,
        timeoutMs,
      );
      const age = seconds(rows[0]?.age_seconds);
      // No due job at all: nothing is waiting, so nothing is stalled.
      checks.jobs = age === null ? "ok" : age * 1000 < maxAgeMs ? "ok" : "stalled";
    } catch {
      checks.jobs = "unknown";
    }
  }

  const ready = checks.database === "ok" && checks.migrations === "ok" && checks.jobs === "ok";
  return { status: ready ? 200 : 503, body: { status: ready ? "ready" : "not_ready", checks } };
}

/**
 * The readiness answer as a Response, for the route. `getSql` is the app's database opener (`@/lib/db`). The folder read and the
 * queries are all bounded; the response is never cached.
 */
export async function readinessResponse(getSql: () => Promise<Sql>): Promise<Response> {
  const result = await checkReadiness({ sql: getSql, migrationFiles: () => migrationFilesIn() });
  return Response.json(result.body, { status: result.status, headers: { "cache-control": "no-store" } });
}
