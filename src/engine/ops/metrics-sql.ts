// The stage metrics of the operations report, read from the engine tables (Video Engine Bible 15.3, 19 E6): stage durations, the
// request wall time, the queue, gate pass rates by gate and format, provider health from the asset stats, and the cost of masters and
// variants from the ledger and the delivered videos. Every statement filters on the workspaces of the scope (tenancy, AGENTS.md rule 2),
// and the rows go through the pure functions of metrics.ts.

import { z } from "zod";
import { costBreakdownSchema } from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { thresholds } from "../config/thresholds.ts";
import { distributionOf, type Distribution } from "./distribution.ts";
import {
  costSummary,
  gatePassRates,
  providerHealth,
  queueSummary,
  stageSamples,
  summarizeStages,
  type AttemptRow,
  type CostSummary,
  type GateRate,
  type LedgerRequestRow,
  type ProviderHealth,
  type QueueMetric,
  type StageEventRow,
  type StageMetric,
  type VideoCostRow,
} from "./metrics.ts";
import { scopeIds, scopeParam, type OpsScope } from "./scope.ts";

export const OPS_METRICS_SCHEMA = "meridian.ops_metrics/v1" as const;

export type MetricsOptions = {
  /** The clock. Defaults to the wall clock. Tests pass a fixed time. */
  now?: () => Date;
  /** Only rows created at or after this ISO time are read. Defaults to the beginning of time (a full read, for small databases). */
  since?: string;
};

export type StageMetricsReport = {
  schema: typeof OPS_METRICS_SCHEMA;
  workspaces: number;
  generatedAt: string;
  requests: {
    total: number;
    delivered: number;
    paused: number;
    rejected: number;
    running: number;
    /** Wall time from the request's start to its deliver result, delivered requests only. */
    wallMs: Distribution;
    /** Delivered requests whose deliver time is not in the log. Counted, never timed as 0. */
    unknownWall: number;
  };
  /** p50 and p95 per stage and basis (metrics.ts: the bases are never pooled). */
  stages: StageMetric[];
  /** Stage results whose start came after the result (a clock problem). Counted, never reported as a duration. */
  negativeStageSamples: number;
  queue: QueueMetric[];
  cost: CostSummary;
  gates: { byGate: GateRate[]; byFormat: GateRate[] };
  providers: ProviderHealth[];
};

type RequestRow = { id: string; format_id: string; status: string; created_at: unknown };
type EventSqlRow = { request_id: string; kind: string; stage: string; subject_id: string; job_id: string; created_at: unknown };
type JobSqlRow = { id: string; job_type: string; status: string; created_at: unknown };
type GateSqlRow = { gate: string; format_id: string; passed: boolean };
type AttemptSqlRow = { provider_id: string; outcome: AttemptRow["outcome"]; error_kind: string | null; latency_ms: unknown };
type DeliveredSqlRow = { request_id: string; body: string };
type LedgerSqlRow = { request_id: string; actual_usd: unknown; actual_is_estimate: boolean | null };

/** The time of a database value (a Date from the driver, or a string), in milliseconds. */
export function msOf(value: unknown): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : Number.NaN;
}

const deliveredBodySchema = z.object({
  manifestId: z.string().min(1),
  variantOf: z.string().min(1).nullable(),
  cost: costBreakdownSchema,
});

/** The stage metrics of the workspaces in the scope. A read that finds nothing reports zero counts and null distributions. */
export async function readStageMetrics(sql: Sql, scope: OpsScope, options: MetricsOptions = {}): Promise<StageMetricsReport> {
  const workspaces = scopeIds(scope);
  const json = scopeParam(scope);
  const now = (options.now ?? (() => new Date()))();
  const since = options.since ?? "1970-01-01T00:00:00.000Z";
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs)) throw new Error("since must be an ISO time");

  const requests = await sql<RequestRow>`
    select id, format_id, status, created_at from engine_requests
    where organization_id in (select value from json_array_elements_text(${json}::json)) and created_at >= ${since}::timestamptz
  `;
  const events = await sql<EventSqlRow>`
    select request_id, kind, stage, subject_id, job_id, created_at from engine_events
    where organization_id in (select value from json_array_elements_text(${json}::json))
      and kind in ('submitted', 'stage.started', 'stage.succeeded', 'stage.dead') and created_at >= ${since}::timestamptz
    order by created_at asc, id asc
  `;
  const jobs = await sql<JobSqlRow>`
    select id, job_type, status, created_at from jobs
    where organization_id in (select value from json_array_elements_text(${json}::json))
      and job_type like 'engine.%' and created_at >= ${since}::timestamptz
  `;
  const gates = await sql<GateSqlRow>`
    select g.gate, r.format_id, g.passed from engine_gate_results g
    join engine_requests r on r.organization_id = g.organization_id and r.id = g.request_id
    where g.organization_id in (select value from json_array_elements_text(${json}::json)) and g.created_at >= ${since}::timestamptz
  `;
  const attempts = await sql<AttemptSqlRow>`
    select provider_id, outcome, error_kind, latency_ms from engine_provider_attempts
    where organization_id in (select value from json_array_elements_text(${json}::json)) and at_ms >= ${sinceMs}
  `;
  const delivered = await sql<DeliveredSqlRow>`
    select request_id, body from engine_events
    where organization_id in (select value from json_array_elements_text(${json}::json))
      and kind = 'video.delivered' and created_at >= ${since}::timestamptz
  `;
  const ledger = await sql<LedgerSqlRow>`
    select request_id, actual_usd, actual_is_estimate from engine_ledger
    where organization_id in (select value from json_array_elements_text(${json}::json)) and at >= ${since}::timestamptz
  `;

  // Stage durations: the events in time order, with the queue time of each job that produced one.
  const jobCreatedMs = new Map<string, number>();
  for (const job of jobs) jobCreatedMs.set(job.id, msOf(job.created_at));
  const eventRows: StageEventRow[] = events.map((row) => ({
    requestId: row.request_id,
    kind: row.kind,
    stage: row.stage,
    subjectId: row.subject_id,
    jobId: row.job_id,
    atMs: msOf(row.created_at),
  }));
  const { samples, negative } = stageSamples(eventRows, jobCreatedMs);

  // The deliver result time of each request: the last stage.succeeded for the deliver stage.
  const deliveredAt = new Map<string, number>();
  for (const row of eventRows) {
    if (row.kind === "stage.succeeded" && row.stage === "deliver") deliveredAt.set(row.requestId, row.atMs);
  }
  const wall: number[] = [];
  let unknownWall = 0;
  let deliveredCount = 0;
  const statusCounts = { delivered: 0, paused: 0, rejected: 0, running: 0 };
  for (const request of requests) {
    if (request.status === "delivered") {
      deliveredCount += 1;
      statusCounts.delivered += 1;
      const endMs = deliveredAt.get(request.id);
      const startMs = msOf(request.created_at);
      if (endMs === undefined || !Number.isFinite(startMs) || endMs < startMs) unknownWall += 1;
      else wall.push(endMs - startMs);
    } else if (request.status === "paused") statusCounts.paused += 1;
    else if (request.status === "rejected") statusCounts.rejected += 1;
    else if (request.status === "running") statusCounts.running += 1;
  }

  // Queue: every engine job of the scope, by type and status, with the age of the oldest queued job at the report time.
  const queue = queueSummary(
    jobs.map((job) => ({ jobType: job.job_type, status: job.status, createdAtMs: msOf(job.created_at) })),
    now.getTime(),
  );

  // Cost: masters and variants from the delivered videos, reconciled against each request's settled ledger.
  const videos: VideoCostRow[] = [];
  for (const row of delivered) {
    const parsedBody = parseDelivered(row.body);
    videos.push({
      requestId: row.request_id,
      videoId: parsedBody?.manifestId ?? "",
      variantOf: parsedBody?.variantOf ?? null,
      totalUsd: parsedBody ? parsedBody.cost.total : null,
    });
  }
  const ledgerByRequest = new Map<string, { actual: number; unsettled: boolean; rows: number; estimateRows: number }>();
  let estimateFlaggedRows = 0;
  for (const row of ledger) {
    const entry = ledgerByRequest.get(row.request_id) ?? { actual: 0, unsettled: false, rows: 0, estimateRows: 0 };
    entry.rows += 1;
    if (row.actual_is_estimate === true) {
      entry.estimateRows += 1;
      estimateFlaggedRows += 1;
    }
    if (row.actual_usd === null) entry.unsettled = true;
    else entry.actual += Number(row.actual_usd);
    ledgerByRequest.set(row.request_id, entry);
  }
  const ledgerRows: LedgerRequestRow[] = [...ledgerByRequest.entries()].map(([requestId, entry]) => ({
    requestId,
    actualUsd: entry.unsettled ? null : entry.actual,
    rows: entry.rows,
    estimateRows: entry.estimateRows,
  }));

  const gateRows = gatePassRates(gates.map((row) => ({ gate: row.gate, formatId: row.format_id, passed: row.passed })));
  const providers = providerHealth(
    attempts.map((row) => ({
      providerId: row.provider_id,
      outcome: row.outcome,
      errorKind: row.error_kind,
      latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
    })),
    thresholds.router.minAttempts.value,
  );

  return {
    schema: OPS_METRICS_SCHEMA,
    workspaces: workspaces.length,
    generatedAt: now.toISOString(),
    requests: {
      total: requests.length,
      delivered: statusCounts.delivered,
      paused: statusCounts.paused,
      rejected: statusCounts.rejected,
      running: statusCounts.running,
      wallMs: distributionOf(wall),
      unknownWall,
    },
    stages: summarizeStages(samples),
    negativeStageSamples: negative,
    queue,
    cost: costSummary(videos, ledgerRows, estimateFlaggedRows),
    gates: gateRows,
    providers,
  };
}

/** A stored video.delivered body, or null when it does not parse against the contract (it then counts as an unknown cost). */
function parseDelivered(text: string): z.infer<typeof deliveredBodySchema> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = deliveredBodySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
