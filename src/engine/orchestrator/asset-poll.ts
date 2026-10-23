// The durable poller for the orchestrator's queued assets (Phase 2). A video or avatar step the provider accepted is a row in
// orchestrator_asset_jobs. This poll reads each due row once: a provider that is still working is polled again later; a finished job is
// settled by the router, and its step's output is stored under the step's cache key, so the next run of the plan reuses it. Nothing is
// stored for a job that did not finish, and a settled job is never settled twice (the router returns the first answer).
//
// Money (owner direction 2026-10-23, decisions D14 and D15). A queued row keeps its hold, which counts toward the plan's spend in every later
// run (holds.ts) until the poll settles the row:
// - held_usd is the hold of the row in total, and hold_usd the hold of one submit. A retry the router submits for the job is a second paid
//   call: the row takes the new job and adds its hold to held_usd, and hold_usd stays the hold of one submit. The same job still working adds
//   nothing, so a settle that is replayed never adds a hold twice. A job still working keeps its hold; its row is otherwise unchanged.
// - A finished job with a reported bill is stored at that bill. The output replaces the hold, so nothing counts twice. When the clip's length
//   is known, the bill is measured once for its plan and cache key (orchestrator_cost_measurements).
// - A finished job with no reported bill is stored at its hold, never at null, and is not measured.
// - A job that failed or is unsettled closes as failed. So does a poll that threw, when its row has a hold. A failed close charges the row's
//   hold to the plan as a failed event, so the spend counts it (store.ts failedHoldsUsd).
// - A row closes once. complete and fail change it only while it is waiting: a close that finds it already closed writes nothing (no output,
//   no measurement, no event) and the poll does not count it. So a failed row's hold is never also a stored bill (D14).
// - A retry the router refuses because the run's reservation has ended closes the row as failed, with RUN_ENDED_REASON: the retry is a new
//   paid call, and it needs a new run (D14).
// - A poll that threw on a row with no recorded hold leaves the row open, and its run keeps refusing: nothing is known about its money until
//   the provider answers. A definitive answer on such a row closes it with no event, because there is no hold to charge.
// Each change of money runs in one transaction, so a row never closes without its event, and an event is never written twice. A write that
// throws propagates: the row stays waiting, so its hold stays counted until a later poll settles it.
//
// The poll is a maintenance job (engine.asset_poll, scheduled per workspace by scripts/scheduler-entry.ts). The pure poll takes its store and
// its router as parameters, so most tests use recorded answers; the database store is tested on the test database.

import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { AssetJob } from "../assets/job.ts";
import type { AssetStep, AsyncAssetRouter, ProduceInput } from "../assets/router.ts";
import { categoryOf } from "./categories.ts";
import type { NodeOutput } from "./execute.ts";
import { recordCostMeasurement } from "./holds.ts";
import { outputOf, type QueuedAsset } from "./production.ts";
import { appendPlanEvents, putStepOutput, type StoredStepOutput } from "./store.ts";

/** How long a still-working job waits before it is polled again. */
export const ASSET_POLL_AGAIN_MS = 30_000;

/** The most a failure reason is kept as: the row's result, and the reason of the failed event that charges its hold. */
const REASON_MAX = 500;

/** The reason a job is closed as failed when its retry is refused because its run has ended (D14): a retry needs a new run. */
export const RUN_ENDED_REASON = "a retry needs a new run; the run that queued this job has ended";

/**
 * The refusal the budget gives a call on a released reservation: "reservation <id> is released; no call is made" (budget/reserve.ts). The router
 * carries it in its reasons. The match is on that text, so a change to the budget's wording needs this pattern changed with it.
 */
const RUN_ENDED_REFUSAL = /reservation \S+ is released; no call is made/;

/** A due row: the job the provider holds, its input, the step it settles, and what it holds. */
export type DueAsset = {
  id: string;
  planId: string;
  stepId: string;
  requestId: string;
  reservationId: string;
  cacheKey: string;
  kind: "video" | "avatar";
  input: ProduceInput;
  job: AssetJob;
  /** The row's hold in total (held_usd). Null when none was recorded: the row is unrecorded, and its money is unknown. */
  heldUsd: number | null;
  /** The clip's length in seconds (seconds), or null when none was recorded. A clip with no length is not measured. */
  seconds: number | null;
};

/** A reported bill and the length of the clip it was for: one measurement. */
export type MeasuredBill = { seconds: number; actualUsd: number };

export type AssetPollStore = {
  /** The rows due now, claimed for this poll so another poll does not take them too. */
  due(limit: number): Promise<DueAsset[]>;
  /**
   * A row that stays open: its job and when to poll it next. A new job (a retry the router submitted) adds its hold to the row's total; the
   * same job, still working, adds nothing.
   */
  reschedule(id: string, change: { job: AssetJob; runAfterMs: number }): Promise<void>;
  /**
   * Stores the output and closes the row done, with its measurement when there is one, in one transaction. Returns false, and writes nothing,
   * when the row is no longer waiting: another poll closed it first.
   */
  complete(row: DueAsset, output: StoredStepOutput, result: string, measured: MeasuredBill | null): Promise<boolean>;
  /**
   * Closes the row failed. A row with a hold charges it to its plan as a failed event, in the same transaction. Returns false, and writes
   * nothing, when the row is no longer waiting: another poll closed it first.
   */
  fail(row: DueAsset, reason: string): Promise<boolean>;
};

export type AssetPollReport = { polled: number; done: number; failed: number; waiting: number };

type PollOptions = {
  store: AssetPollStore;
  organizationId: string;
  routerFor: (scope: { organizationId: string; requestId: string; reservationId: string }) => AsyncAssetRouter;
  limit?: number;
};

/** What one poll decided for its row. */
type Verdict =
  | { kind: "waiting"; job: AssetJob; runAfterMs: number }
  | { kind: "done"; output: StoredStepOutput; result: string; measured: MeasuredBill | null }
  | { kind: "failed"; reason: string };

export async function pollAssetJobs(opts: PollOptions): Promise<AssetPollReport> {
  const report: AssetPollReport = { polled: 0, done: 0, failed: 0, waiting: 0 };
  for (const row of await opts.store.due(opts.limit ?? 10)) {
    report.polled += 1;
    const verdict = await verdictOf(opts, row);
    if (verdict.kind === "waiting") {
      await opts.store.reschedule(row.id, { job: verdict.job, runAfterMs: verdict.runAfterMs });
      report.waiting += 1;
    } else if (verdict.kind === "done") {
      // A row another poll closed first is not counted: its close wrote nothing.
      if (await opts.store.complete(row, verdict.output, verdict.result, verdict.measured)) report.done += 1;
    } else if (await opts.store.fail(row, verdict.reason)) {
      report.failed += 1;
    }
  }
  return report;
}

/** The poll's decision for one row. A provider that does not answer is a decision too: it never escapes as an exception. */
async function verdictOf(opts: PollOptions, row: DueAsset): Promise<Verdict> {
  let step: AssetStep;
  try {
    const router = opts.routerFor({ organizationId: opts.organizationId, requestId: row.requestId, reservationId: row.reservationId });
    const polled = await router.pollOnce(row.job, row.input);
    if (polled.state === "pending") return { kind: "waiting", job: row.job, runAfterMs: ASSET_POLL_AGAIN_MS };
    step = (await router.settle(row.job, polled, row.input)).step;
  } catch (error) {
    // Nothing is known about the job. Its hold is charged as failed, or, with no hold recorded, the row stays open until the provider answers.
    return row.heldUsd === null ? { kind: "waiting", job: row.job, runAfterMs: ASSET_POLL_AGAIN_MS } : { kind: "failed", reason: reasonOf(error) };
  }
  if (step.status === "submitted") {
    // A retry the router submitted: a second paid call. The row takes the new job, and the store adds its hold to the row's total.
    return { kind: "waiting", job: step.job, runAfterMs: step.runAfterMs };
  }
  // A retry the router refused because the run's reservation has ended: no call starts, and a new run is what a retry needs (D14).
  if (isRunEndedRefusal(step)) return { kind: "failed", reason: RUN_ENDED_REASON };
  let output: NodeOutput;
  try {
    // outputOf names the reason for every outcome that is not a finished asset, so the row records why it stopped.
    output = outputOf(step, row.kind);
  } catch (error) {
    return { kind: "failed", reason: reasonOf(error) };
  }
  const bill = reportedUsdOf(output.costUsd);
  if (bill === null && row.heldUsd === null) {
    return { kind: "failed", reason: "the step reported no actual cost and no hold is recorded, so nothing is stored" };
  }
  return {
    kind: "done",
    // The reported bill replaces the hold. With none reported, the output is charged its hold: never null, never zero.
    output: { outputHash: output.outputHash, costUsd: bill ?? row.heldUsd, body: output.body ?? null, category: categoryOf(row.kind) },
    result: bill === null ? "stored at its hold: no actual cost was reported" : "stored",
    measured: bill === null || row.seconds === null ? null : { seconds: row.seconds, actualUsd: bill },
  };
}

/** A bill the provider reported: a finite, non-negative figure. Anything else is no bill at all, never a zero. */
function reportedUsdOf(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : "the poll failed").slice(0, REASON_MAX);
}

/** Whether the router refused the job's retry, or its fallback, because the run's reservation is released. The router names the refusal in its reasons. */
function isRunEndedRefusal(step: AssetStep): boolean {
  if (step.status !== "refused" && step.status !== "unavailable") return false;
  return step.reasons.some((reason) => RUN_ENDED_REFUSAL.test(reason));
}

/** Records one accepted submit so the poller settles it. The row's poll is due after the provider's own first wait, and its hold counts from now. */
export async function queueAssetJob(sql: Sql, organizationId: string, entry: QueuedAsset): Promise<void> {
  const delaySecs = Math.max(1, Math.ceil(entry.runAfterMs / 1000));
  await sql`
    insert into orchestrator_asset_jobs (
      id, organization_id, plan_id, request_id, reservation_id, step_id, cache_key, kind, input, job, next_poll_at,
      held_usd, hold_usd, seconds
    ) values (
      ${globalThis.crypto.randomUUID()}, ${organizationId}, ${entry.planId}, ${entry.input.requestId}, ${entry.input.reservationId},
      ${entry.stepId}, ${entry.cacheKey}, ${entry.kind}, ${JSON.stringify(entry.input)}::jsonb, ${JSON.stringify(entry.job)}::jsonb,
      now() + make_interval(secs => ${delaySecs}), ${entry.hold}, ${entry.hold}, ${entry.seconds}
    )
  `;
}

/** The rows of orchestrator_asset_jobs, as the poll reads them. JSON columns come back as text on some drivers, so both are accepted. */
function jsonOf<T>(value: unknown): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
}

/** A numeric column as a number, or null when it is null. Numeric columns come back as text on some drivers. */
function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** Runs fn in one transaction, or refuses. A change of money never runs half-applied (the same rule as the learning store). */
async function inTransaction<T>(sql: Sql, fn: (tx: Sql) => Promise<T>): Promise<T> {
  if (!sql.begin) throw new Error("This database connection cannot run a transaction, so the operation was not started.");
  return sql.begin(fn);
}

/**
 * Closes a row, inside the caller's transaction, only while it is waiting (D14). Returns false when the row is no longer waiting: another poll
 * closed it, so the caller writes nothing for it. Throws when the row is not in this organization.
 */
async function closeWaiting(tx: Sql, organizationId: string, id: string, status: "done" | "failed", result: string): Promise<boolean> {
  const closed = await tx`
    update orchestrator_asset_jobs set status = ${status}, result = ${result}, updated_at = now()
    where id = ${id} and organization_id = ${organizationId} and status = 'waiting'
    returning id
  `;
  if (closed.length > 0) return true;
  const present = await tx`select id from orchestrator_asset_jobs where id = ${id} and organization_id = ${organizationId}`;
  if (present.length === 0) throw new Error("the job is not in this organization, so it is not closed");
  return false;
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
        returning id, plan_id, step_id, request_id, reservation_id, cache_key, kind, input, job, held_usd, seconds
      `;
      return rows.map((row) => ({
        id: String(row.id),
        planId: String(row.plan_id),
        stepId: String(row.step_id),
        requestId: String(row.request_id),
        reservationId: String(row.reservation_id),
        cacheKey: String(row.cache_key),
        kind: row.kind === "avatar" ? "avatar" : "video",
        input: jsonOf<ProduceInput>(row.input),
        job: jsonOf<AssetJob>(row.job),
        heldUsd: numberOrNull(row.held_usd),
        seconds: numberOrNull(row.seconds),
      }));
    },
    async reschedule(id, change) {
      const delaySecs = Math.max(1, Math.ceil(change.runAfterMs / 1000));
      // The hold total grows by one hold only when the job is new: the stored job is compared before it is replaced.
      await sql`
        update orchestrator_asset_jobs
        set job = ${JSON.stringify(change.job)}::jsonb,
          held_usd = case when job->>'idempotencyKey' = ${change.job.idempotencyKey} then held_usd else held_usd + hold_usd end,
          next_poll_at = now() + make_interval(secs => ${delaySecs}), updated_at = now()
        where id = ${id} and organization_id = ${organizationId}
      `;
    },
    async complete(row, output, result, measured) {
      return inTransaction(sql, async (tx) => {
        // The row closes first. A row that is no longer waiting was closed by another poll, and nothing else is written for it.
        if (!(await closeWaiting(tx, organizationId, row.id, "done", result))) return false;
        if (!(await putStepOutput(tx, organizationId, row.planId, row.cacheKey, output))) {
          throw new Error("the plan is not in this organization, so the step's output is not stored");
        }
        if (measured !== null) {
          await recordCostMeasurement(tx, organizationId, {
            planId: row.planId,
            cacheKey: row.cacheKey,
            kind: row.kind,
            seconds: measured.seconds,
            actualUsd: measured.actualUsd,
          });
        }
        return true;
      });
    },
    async fail(row, reason) {
      return inTransaction(sql, async (tx) => {
        // The row closes first. A row that is no longer waiting was closed by another poll, so its hold is not charged a second time.
        if (!(await closeWaiting(tx, organizationId, row.id, "failed", reason))) return false;
        if (row.heldUsd !== null) {
          const recorded = await appendPlanEvents(tx, organizationId, row.planId, [
            { nodeId: row.stepId, state: "failed", outputHash: null, costUsd: row.heldUsd, reason },
          ]);
          if (!recorded) throw new Error("the plan is not in this organization, so its failed hold is not recorded");
        }
        return true;
      });
    },
  };
}
