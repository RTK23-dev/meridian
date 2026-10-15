// Reads the snapshot the alert rules evaluate (alerts.ts) from the engine tables, for the workspaces of a scope (Video Engine Bible 15.3,
// 19 E6). Every statement filters on the scope's workspaces; the clock is passed in, so a test or a replay evaluates a fixed time.

import type { Sql } from "../../lib/meridian/learning/store.ts";
import { parseJsonRecord } from "./json.ts";
import { readEngineRequest } from "../jobs/orchestrator-sql.ts";
import { requestIdOfKey } from "./deadletter.ts";
import type { AlertSnapshot } from "./alerts.ts";
import { msOf } from "./metrics-sql.ts";
import { scopeParam, type OpsScope } from "./scope.ts";
import type { OpsThresholds } from "./thresholds.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The alert snapshot for the workspaces in the scope, at nowMs. A dead job older than a day is not looked at (open dead letters are read from their pause). */
export async function readAlertSnapshot(sql: Sql, scope: OpsScope, nowMs: number, thresholds: OpsThresholds): Promise<AlertSnapshot> {
  const json = scopeParam(scope);
  const lookbackStart = iso(nowMs - DAY_MS);
  const gateStart = iso(nowMs - thresholds.gatePass.recentWindowMinutes * 60_000 - thresholds.gatePass.baselineWindowMinutes * 60_000);

  const deadRows = await sql<{ id: string; organization_id: string; idempotency_key: string; payload: string; updated_at: unknown; replayed: boolean }>`
    select j.id, j.organization_id, j.idempotency_key, j.payload, j.updated_at,
      exists (select 1 from engine_events e where e.organization_id = j.organization_id and e.dedupe_key = 'replay:' || j.id) as replayed
    from jobs j
    where j.organization_id in (select value from json_array_elements_text(${json}::json))
      and j.job_type like 'engine.%' and j.status = 'dead' and j.updated_at >= ${lookbackStart}::timestamptz
  `;

  const pausedRows = await sql<{ id: string; organization_id: string; state: string }>`
    select id, organization_id, state from engine_requests
    where organization_id in (select value from json_array_elements_text(${json}::json)) and status = 'paused'
  `;
  const deadEvents = await sql<{ organization_id: string; request_id: string; stage: string; subject_id: string; at: unknown }>`
    select organization_id, request_id, stage, subject_id, max(created_at) as at from engine_events
    where organization_id in (select value from json_array_elements_text(${json}::json)) and kind = 'stage.dead'
    group by organization_id, request_id, stage, subject_id
  `;
  const deadAt = new Map<string, number>();
  for (const row of deadEvents) deadAt.set(`${row.organization_id}|${row.request_id}|${row.stage}|${row.subject_id}`, msOf(row.at));

  const reservationRows = await sql<{ id: string; organization_id: string; request_id: string; state: string; estimate_usd: unknown; redo_allowance_usd: unknown }>`
    select id, organization_id, request_id, state, estimate_usd, redo_allowance_usd from engine_reservations
    where organization_id in (select value from json_array_elements_text(${json}::json))
  `;
  const ledgerSums = await sql<{ organization_id: string; reservation_id: string; settled: unknown; unsettled: unknown }>`
    select organization_id, reservation_id, coalesce(sum(actual_usd), 0) as settled, count(*) filter (where actual_usd is null) as unsettled
    from engine_ledger
    where organization_id in (select value from json_array_elements_text(${json}::json))
    group by organization_id, reservation_id
  `;
  const settledBy = new Map<string, { settled: number; unsettled: number }>();
  for (const row of ledgerSums) {
    settledBy.set(`${row.organization_id}|${row.reservation_id}`, { settled: Number(row.settled), unsettled: Number(row.unsettled) });
  }

  const deliveredRows = await sql<{ id: string; organization_id: string; format_id: string }>`
    select id, organization_id, format_id from engine_requests
    where organization_id in (select value from json_array_elements_text(${json}::json)) and status = 'delivered'
  `;
  const deliverEvents = await sql<{ organization_id: string; request_id: string; at: unknown }>`
    select organization_id, request_id, max(created_at) as at from engine_events
    where organization_id in (select value from json_array_elements_text(${json}::json)) and kind = 'stage.succeeded' and stage = 'deliver'
    group by organization_id, request_id
  `;
  const deliveredAt = new Map<string, number>();
  for (const row of deliverEvents) deliveredAt.set(`${row.organization_id}|${row.request_id}`, msOf(row.at));

  const breakerRows = await sql<{ organization_id: string; provider_id: string; tripped_at_ms: unknown; open_until_ms: unknown }>`
    select organization_id, provider_id, tripped_at_ms, open_until_ms from engine_provider_breakers
    where organization_id in (select value from json_array_elements_text(${json}::json)) and open_until_ms > ${nowMs}
  `;

  const stuckRows = await sql<{ id: string; organization_id: string; updated_at: unknown }>`
    select r.id, r.organization_id, r.updated_at from engine_requests r
    where r.organization_id in (select value from json_array_elements_text(${json}::json)) and r.status = 'running'
      and not exists (
        select 1 from jobs j
        where j.organization_id = r.organization_id and j.status in ('queued', 'running', 'retry')
          and left(j.idempotency_key, length('engine:' || r.id || ':')) = 'engine:' || r.id || ':'
      )
  `;

  const gateRows = await sql<{ organization_id: string; gate: string; passed: boolean; created_at: unknown }>`
    select organization_id, gate, passed, created_at from engine_gate_results
    where organization_id in (select value from json_array_elements_text(${json}::json)) and created_at >= ${gateStart}::timestamptz
  `;

  // Dead jobs, with the dead event's request. A payload that does not parse still counts as dead (it is listed, never hidden).
  const deadJobs: AlertSnapshot["deadJobs"] = [];
  for (const row of deadRows) {
    const requestId = requestIdOfKey(row.idempotency_key);
    if (requestId === null) continue;
    const payload = parseJsonRecord(row.payload);
    deadJobs.push({
      organizationId: row.organization_id,
      jobId: row.id,
      requestId,
      stage: typeof payload?.stage === "string" ? payload.stage : null,
      deadAtMs: msOf(row.updated_at),
      replayed: row.replayed,
    });
  }

  // Requests paused on a dead letter. The pause names the stage and subject; its time is the dead event's time.
  const pausedDeadLetters: AlertSnapshot["pausedDeadLetters"] = [];
  for (const row of pausedRows) {
    const request = await readEngineRequest(sql, row.organization_id, row.id);
    const pause = request?.state.pause;
    if (!request || !pause || pause.kind !== "dead_letter") continue;
    const pausedAtMs = deadAt.get(`${row.organization_id}|${row.id}|${pause.stage}|${pause.subjectId}`);
    if (pausedAtMs === undefined || !Number.isFinite(pausedAtMs)) continue;
    pausedDeadLetters.push({ organizationId: row.organization_id, requestId: row.id, stage: pause.stage, subjectId: pause.subjectId, pausedAtMs });
  }

  const reservations: AlertSnapshot["reservations"] = reservationRows.map((row) => {
    const sums = settledBy.get(`${row.organization_id}|${row.id}`) ?? { settled: 0, unsettled: 0 };
    return {
      organizationId: row.organization_id,
      requestId: row.request_id,
      reservationId: row.id,
      ceilingUsd: Number(row.estimate_usd) + Number(row.redo_allowance_usd),
      settledUsd: sums.settled,
      unsettledRows: sums.unsettled,
    };
  });

  // A delivered request's estimate is the estimate of its released reservations (deliver releases the hold, Bible 14.1 step 5); its actual
  // is the settled sum of its reservations, and null while any of their rows is unsettled.
  const estimateByRequest = new Map<string, number>();
  const actualByRequest = new Map<string, { settled: number; unsettled: number }>();
  for (const row of reservationRows) {
    const key = `${row.organization_id}|${row.request_id}`;
    if (row.state === "released") estimateByRequest.set(key, (estimateByRequest.get(key) ?? 0) + Number(row.estimate_usd));
    const sums = settledBy.get(`${row.organization_id}|${row.id}`) ?? { settled: 0, unsettled: 0 };
    const total = actualByRequest.get(key) ?? { settled: 0, unsettled: 0 };
    total.settled += sums.settled;
    total.unsettled += sums.unsettled;
    actualByRequest.set(key, total);
  }
  const deliveredRequests: AlertSnapshot["deliveredRequests"] = [];
  for (const row of deliveredRows) {
    const key = `${row.organization_id}|${row.id}`;
    const deliveredMs = deliveredAt.get(key);
    const estimate = estimateByRequest.get(key);
    const actual = actualByRequest.get(key);
    if (deliveredMs === undefined || estimate === undefined) continue;
    deliveredRequests.push({
      organizationId: row.organization_id,
      requestId: row.id,
      formatId: row.format_id,
      estimateUsd: estimate,
      actualUsd: actual === undefined || actual.unsettled > 0 ? null : actual.settled,
      deliveredAtMs: deliveredMs,
    });
  }

  return {
    nowMs,
    deadJobs,
    pausedDeadLetters,
    reservations,
    deliveredRequests,
    openBreakers: breakerRows.map((row) => ({
      organizationId: row.organization_id,
      providerId: row.provider_id,
      trippedAtMs: Number(row.tripped_at_ms),
      openUntilMs: Number(row.open_until_ms),
    })),
    stuckRequests: stuckRows.map((row) => ({ organizationId: row.organization_id, requestId: row.id, idleSinceMs: msOf(row.updated_at) })),
    gateEvaluations: gateRows.map((row) => ({ organizationId: row.organization_id, gate: row.gate, passed: row.passed, atMs: msOf(row.created_at) })),
  };
}
