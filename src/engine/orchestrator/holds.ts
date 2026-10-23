// Holds and measured costs of queued assets (owner direction 2026-10-23, decisions D14 and D15). A video or avatar job the provider accepted is
// a row in orchestrator_asset_jobs, and its hold stays on that row until the poll settles it (asset-poll.ts). These reads count the holds in
// every later run of the plan, not only in the run that queued the job, so a re-run cannot start new paid steps while a job waits.
//
// - waitingHoldsByNode: the holds of the plan's waiting jobs, summed by step. A waiting job with no recorded hold is listed as unrecorded: it
//   is never counted as zero, and its run refuses until the poll settles it.
// - openQueuedJob: whether the plan has a waiting job for a cache key. A re-run then reports the step queued and submits nothing.
// - recordCostMeasurement and measuredAverageUsdPerSecond: a measurement is one reported bill for a clip, with its length. It is written only
//   for a reported actual cost, never for an estimate. The average is shown; it never sets a hold.
//
// Every query is scoped to the organization. A plan of another organization reads as nothing and is written to by nothing.

import type { Sql } from "../../lib/meridian/learning/store.ts";

export type WaitingHolds = {
  /** The holds of the plan's waiting jobs that have one, summed by step. */
  byNode: Map<string, number>;
  /** The steps with a waiting job whose hold is not recorded, sorted. Their money is unknown, so the run refuses until the poll settles them. */
  unrecorded: string[];
};

/** The holds of a plan's waiting jobs, by step (see the file comment). Empty when the plan is not the organization's. */
export async function waitingHoldsByNode(sql: Sql, organizationId: string, planId: string): Promise<WaitingHolds> {
  const rows = await sql<Record<string, unknown>>`
    select step_id, held_usd from orchestrator_asset_jobs
    where organization_id = ${organizationId} and plan_id = ${planId} and status = 'waiting'
  `;
  const byNode = new Map<string, number>();
  const unrecorded = new Set<string>();
  for (const row of rows) {
    const stepId = String(row.step_id);
    if (row.held_usd === null || row.held_usd === undefined) {
      unrecorded.add(stepId);
      continue;
    }
    byNode.set(stepId, (byNode.get(stepId) ?? 0) + Number(row.held_usd));
  }
  return { byNode, unrecorded: [...unrecorded].sort() };
}

/** Whether the plan has a job waiting for this cache key. Its hold is counted already, so a re-run must not submit it again. */
export async function openQueuedJob(sql: Sql, organizationId: string, planId: string, cacheKey: string): Promise<boolean> {
  const rows = await sql`
    select id from orchestrator_asset_jobs
    where organization_id = ${organizationId} and plan_id = ${planId} and cache_key = ${cacheKey} and status = 'waiting'
    limit 1
  `;
  return rows.length > 0;
}

/** One reported bill for a clip: its plan, its cache key, its kind, its length in seconds and the bill the provider reported. */
export type CostMeasurement = { planId: string; cacheKey: string; kind: "video" | "avatar"; seconds: number; actualUsd: number };

/**
 * Records one measured clip. A plan and cache key have at most one measurement, so a second record for the same key adds nothing. Returns
 * false when nothing was written: the key is already measured, or the plan is not the organization's.
 */
export async function recordCostMeasurement(sql: Sql, organizationId: string, measurement: CostMeasurement): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    insert into orchestrator_cost_measurements (id, organization_id, plan_id, cache_key, kind, seconds, actual_usd)
    select ${globalThis.crypto.randomUUID()}::text, organization_id, id, ${measurement.cacheKey}::text, ${measurement.kind}::text,
      ${measurement.seconds}::numeric, ${measurement.actualUsd}::numeric
    from orchestrator_plans where id = ${measurement.planId} and organization_id = ${organizationId}
    on conflict (plan_id, cache_key) do nothing
    returning id
  `;
  return rows.length > 0;
}

/**
 * The organization's average reported cost per second of its measured clips: the sum of the reported bills over the sum of the lengths.
 * Null when no clip has been measured. It is shown, never used to set a hold.
 */
export async function measuredAverageUsdPerSecond(sql: Sql, organizationId: string): Promise<{ usdPerSecond: number; seconds: number; clips: number } | null> {
  const rows = await sql<Record<string, unknown>>`
    select count(*) as clips, coalesce(sum(actual_usd), 0) as actual_usd, coalesce(sum(seconds), 0) as seconds
    from orchestrator_cost_measurements where organization_id = ${organizationId}
  `;
  const clips = Number(rows[0]?.clips ?? 0);
  const seconds = Number(rows[0]?.seconds ?? 0);
  if (clips === 0 || !(seconds > 0)) return null;
  return { usdPerSecond: Number(rows[0]?.actual_usd ?? 0) / seconds, seconds, clips };
}
