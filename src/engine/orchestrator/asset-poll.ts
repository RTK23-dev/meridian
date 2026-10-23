// The durable poller for the orchestrator's queued assets (Phase 2). A video or avatar step the provider accepted is a row in
// orchestrator_asset_jobs. This poll reads each due row once: a provider that is still working is polled again later; a finished job is
// settled by the router, and its step's output is stored under the step's cache key, so the next run of the plan reuses it. Nothing is
// stored for a job that did not finish, and a settled job is never settled twice (the router returns the first answer).
//
// The poll is a maintenance job (engine.asset_poll, scheduled per workspace by scripts/scheduler-entry.ts). It takes the store and the
// router as parameters, so the tests use recorded answers and no database.

import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { AssetJob } from "../assets/job.ts";
import type { AsyncAssetRouter, ProduceInput } from "../assets/router.ts";
import { categoryOf } from "./categories.ts";
import { outputOf, type QueuedAsset } from "./production.ts";
import { putStepOutput, type StoredStepOutput } from "./store.ts";

/** How long a still-working job waits before it is polled again. */
export const ASSET_POLL_AGAIN_MS = 30_000;

/** A due row: the job the provider holds, its input, and the step it settles. */
export type DueAsset = {
  id: string;
  planId: string;
  requestId: string;
  reservationId: string;
  cacheKey: string;
  kind: "video" | "avatar";
  input: ProduceInput;
  job: AssetJob;
};

export type AssetPollStore = {
  /** The rows due now, claimed for this poll so another poll does not take them too. */
  due(limit: number): Promise<DueAsset[]>;
  /** A row that is still open: its job (possibly a new submit after a retry) and when to poll it next. */
  reschedule(id: string, change: { job: AssetJob; runAfterMs: number }): Promise<void>;
  finish(id: string, status: "done" | "failed", result: string): Promise<void>;
  putOutput(planId: string, cacheKey: string, output: StoredStepOutput): Promise<void>;
};

export type AssetPollReport = { polled: number; done: number; failed: number; waiting: number };

export async function pollAssetJobs(opts: {
  store: AssetPollStore;
  organizationId: string;
  routerFor: (scope: { organizationId: string; requestId: string; reservationId: string }) => AsyncAssetRouter;
  limit?: number;
}): Promise<AssetPollReport> {
  const report: AssetPollReport = { polled: 0, done: 0, failed: 0, waiting: 0 };
  for (const row of await opts.store.due(opts.limit ?? 10)) {
    report.polled += 1;
    try {
      const router = opts.routerFor({ organizationId: opts.organizationId, requestId: row.requestId, reservationId: row.reservationId });
      const polled = await router.pollOnce(row.job, row.input);
      if (polled.state === "pending") {
        await opts.store.reschedule(row.id, { job: row.job, runAfterMs: ASSET_POLL_AGAIN_MS });
        report.waiting += 1;
        continue;
      }
      const step = (await router.settle(row.job, polled, row.input)).step;
      if (step.status === "submitted") {
        // A retry on the same target or the next one: the row now holds the new job.
        await opts.store.reschedule(row.id, { job: step.job, runAfterMs: step.runAfterMs });
        report.waiting += 1;
        continue;
      }
      // outputOf names the reason for every outcome that is not a finished asset, so the row records why it stopped.
      const output = outputOf(step, row.kind);
      await opts.store.putOutput(row.planId, row.cacheKey, {
        outputHash: output.outputHash,
        costUsd: output.costUsd,
        body: output.body ?? null,
        category: categoryOf(row.kind),
      });
      await opts.store.finish(row.id, "done", "stored");
      report.done += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "the poll failed";
      await opts.store.finish(row.id, "failed", reason.slice(0, 500));
      report.failed += 1;
    }
  }
  return report;
}

/** Records one accepted submit so the poller settles it. The row's poll is due after the provider's own first wait. */
export async function queueAssetJob(sql: Sql, organizationId: string, entry: QueuedAsset): Promise<void> {
  const seconds = Math.max(1, Math.ceil(entry.runAfterMs / 1000));
  await sql`
    insert into orchestrator_asset_jobs (
      id, organization_id, plan_id, request_id, reservation_id, step_id, cache_key, kind, input, job, next_poll_at
    ) values (
      ${globalThis.crypto.randomUUID()}, ${organizationId}, ${entry.planId}, ${entry.input.requestId}, ${entry.input.reservationId},
      ${entry.stepId}, ${entry.cacheKey}, ${entry.kind}, ${JSON.stringify(entry.input)}::jsonb, ${JSON.stringify(entry.job)}::jsonb,
      now() + make_interval(secs => ${seconds})
    )
  `;
}

/** The rows of orchestrator_asset_jobs, as the poll reads them. JSON columns come back as text on some drivers, so both are accepted. */
function jsonOf<T>(value: unknown): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
}

/** The poll's store over the database, for one workspace. A due row is claimed by pushing its next poll out before it is read. */
export function sqlAssetPollStore(sql: Sql, organizationId: string): AssetPollStore {
  return {
    async due(limit) {
      const rows = await sql<Record<string, unknown>>`
        update orchestrator_asset_jobs
        set next_poll_at = now() + interval '2 minutes', attempts = attempts + 1, updated_at = now()
        where id in (
          select id from orchestrator_asset_jobs
          where organization_id = ${organizationId} and status = 'waiting' and next_poll_at <= now()
          order by next_poll_at
          limit ${limit}
          for update skip locked
        )
        returning id, plan_id, request_id, reservation_id, cache_key, kind, input, job
      `;
      return rows.map((row) => ({
        id: String(row.id),
        planId: String(row.plan_id),
        requestId: String(row.request_id),
        reservationId: String(row.reservation_id),
        cacheKey: String(row.cache_key),
        kind: row.kind === "avatar" ? "avatar" : "video",
        input: jsonOf<ProduceInput>(row.input),
        job: jsonOf<AssetJob>(row.job),
      }));
    },
    async reschedule(id, change) {
      const seconds = Math.max(1, Math.ceil(change.runAfterMs / 1000));
      await sql`
        update orchestrator_asset_jobs
        set job = ${JSON.stringify(change.job)}::jsonb, next_poll_at = now() + make_interval(secs => ${seconds}), updated_at = now()
        where id = ${id} and organization_id = ${organizationId}
      `;
    },
    async finish(id, status, result) {
      await sql`
        update orchestrator_asset_jobs set status = ${status}, result = ${result}, updated_at = now()
        where id = ${id} and organization_id = ${organizationId}
      `;
    },
    async putOutput(planId, cacheKey, output) {
      await putStepOutput(sql, organizationId, planId, cacheKey, output);
    },
  };
}
