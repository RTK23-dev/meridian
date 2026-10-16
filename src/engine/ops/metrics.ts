// Operations metrics as pure functions over rows the SQL reader gives them (Video Engine Bible 15.3, 19 E6). Nothing here reads a
// database or a clock: the reader passes the rows and the time, so every function is tested on fixed numbers. A metric whose
// inputs are missing is null (or counted as unknown), never 0 (Bible 0, rule 1).

import { roundUsd, sumUsd } from "../contracts/index.ts";
import { distributionOf, percentile, rateOf } from "./distribution.ts";

// --- Stage durations (Bible 15.3: p50 and p95 duration per stage) -------------------------------------------------------------

/**
 * How a duration was measured. started_to_result: the dispatcher recorded when the job began (a stage.started event). submit_to_result:
 * an asynchronous provider call, from its submission to its settled result. queued_to_result: the job's queue time to its result, which
 * includes the wait in the queue. The three are never pooled: each has its own distribution.
 */
export type StageBasis = "started_to_result" | "submit_to_result" | "queued_to_result";

/** One event of the stage log, in the order it was stored. atMs is the event's time in milliseconds. */
export type StageEventRow = { requestId: string; kind: string; stage: string; subjectId: string; jobId: string; atMs: number };

export type StageSample = { requestId: string; stage: string; basis: StageBasis; ms: number };

export type StageSamples = { samples: StageSample[]; negative: number };

/**
 * Pairs each stage result with the start of its attempt. The events are read in time order. A submitted event opens an attempt for a
 * request, stage and subject (the first submission of the attempt wins, so a fallback target does not restart the clock). A stage.dead
 * closes it without a result. A stage.succeeded takes its duration from the open submission, else from the started event of its job, else
 * from the job's queue time. A negative duration is counted, not reported.
 */
export function stageSamples(events: readonly StageEventRow[], jobCreatedMs: ReadonlyMap<string, number>): StageSamples {
  const openSubmits = new Map<string, number>();
  const startedAt = new Map<string, number>();
  const samples: StageSample[] = [];
  let negative = 0;
  const attemptKey = (event: StageEventRow): string => `${event.requestId}|${event.stage}|${event.subjectId}`;
  for (const event of events) {
    switch (event.kind) {
      case "submitted":
        if (!openSubmits.has(attemptKey(event))) openSubmits.set(attemptKey(event), event.atMs);
        break;
      case "stage.started":
        startedAt.set(event.jobId, event.atMs);
        break;
      case "stage.dead":
        openSubmits.delete(attemptKey(event));
        break;
      case "stage.succeeded": {
        const key = attemptKey(event);
        let start: number | undefined;
        let basis: StageBasis;
        if (openSubmits.has(key)) {
          start = openSubmits.get(key);
          basis = "submit_to_result";
          openSubmits.delete(key);
        } else if (startedAt.has(event.jobId)) {
          start = startedAt.get(event.jobId);
          basis = "started_to_result";
        } else {
          start = jobCreatedMs.get(event.jobId);
          basis = "queued_to_result";
        }
        startedAt.delete(event.jobId);
        if (start === undefined) break;
        const ms = event.atMs - start;
        if (ms < 0) negative += 1;
        else samples.push({ requestId: event.requestId, stage: event.stage, basis, ms });
        break;
      }
      default:
        break;
    }
  }
  return { samples, negative };
}

export type StageMetric = { stage: string; basis: StageBasis; count: number; p50Ms: number | null; p95Ms: number | null };

/** The distribution of the samples per stage and basis, in stage order. */
export function summarizeStages(samples: readonly StageSample[]): StageMetric[] {
  const groups = new Map<string, { stage: string; basis: StageBasis; values: number[] }>();
  for (const sample of samples) {
    const key = `${sample.stage}|${sample.basis}`;
    const group = groups.get(key) ?? { stage: sample.stage, basis: sample.basis, values: [] };
    group.values.push(sample.ms);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => (a.stage === b.stage ? a.basis.localeCompare(b.basis) : a.stage.localeCompare(b.stage)))
    .map((group) => {
      const stats = distributionOf(group.values);
      return { stage: group.stage, basis: group.basis, count: stats.count, p50Ms: stats.p50, p95Ms: stats.p95 };
    });
}

// --- Gate pass rates (Bible 15.3: gate pass rate by gate and format) ----------------------------------------------------------

export type GateRow = { gate: string; formatId: string; passed: boolean };

export type GateRate = { gate: string; formatId: string | null; total: number; passed: number; passRate: number | null };

/** Passed evaluations over all evaluations, by gate and by gate and format. An evaluation is one stored gate result (a redo adds one). */
export function gatePassRates(rows: readonly GateRow[]): { byGate: GateRate[]; byFormat: GateRate[] } {
  const byGate = new Map<string, { total: number; passed: number }>();
  const byFormat = new Map<string, { gate: string; formatId: string; total: number; passed: number }>();
  for (const row of rows) {
    const gate = byGate.get(row.gate) ?? { total: 0, passed: 0 };
    gate.total += 1;
    if (row.passed) gate.passed += 1;
    byGate.set(row.gate, gate);
    const key = `${row.gate}|${row.formatId}`;
    const cell = byFormat.get(key) ?? { gate: row.gate, formatId: row.formatId, total: 0, passed: 0 };
    cell.total += 1;
    if (row.passed) cell.passed += 1;
    byFormat.set(key, cell);
  }
  const rate = (gate: string, formatId: string | null, cell: { total: number; passed: number }): GateRate => ({
    gate,
    formatId,
    total: cell.total,
    passed: cell.passed,
    passRate: rateOf(cell.passed, cell.total),
  });
  return {
    byGate: [...byGate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([gate, cell]) => rate(gate, null, cell)),
    byFormat: [...byFormat.values()]
      .sort((a, b) => (a.gate === b.gate ? a.formatId.localeCompare(b.formatId) : a.gate.localeCompare(b.gate)))
      .map((cell) => rate(cell.gate, cell.formatId, cell)),
  };
}

// --- Provider success rates (Bible 10.2, 10.4, 15.3: from the asset stats) -----------------------------------------------------

export type AttemptRow = {
  providerId: string;
  outcome: "success" | "provider_failure" | "request_refused";
  errorKind: string | null;
  latencyMs: number | null;
};

export type ProviderHealth = {
  providerId: string;
  /** Every recorded attempt, refusals included. */
  attempts: number;
  successes: number;
  providerFailures: number;
  /** Refusals are the request's fault, not the provider's, so they are counted apart and leave the rates alone (assets/breaker.ts). */
  refused: number;
  /** Provider-side attempts: successes plus provider failures. */
  providerSide: number;
  /** False below the minimum sample. Such a rate is unknown, and it is reported as null (Bible 10.2: not scored as 0 or 1). */
  reliable: boolean;
  successRate: number | null;
  /** Share of the provider-side attempts that were rate limited (HTTP 429). Null when there were none. */
  rateLimitShare: number | null;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
};

/** The health of every provider that has an attempt in the rows, by provider id. */
export function providerHealth(rows: readonly AttemptRow[], minAttempts: number): ProviderHealth[] {
  const byProvider = new Map<string, AttemptRow[]>();
  for (const row of rows) {
    const list = byProvider.get(row.providerId) ?? [];
    list.push(row);
    byProvider.set(row.providerId, list);
  }
  return [...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([providerId, list]) => {
      const successes = list.filter((row) => row.outcome === "success").length;
      const providerFailures = list.filter((row) => row.outcome === "provider_failure").length;
      const refused = list.filter((row) => row.outcome === "request_refused").length;
      const providerSide = successes + providerFailures;
      const rateLimited = list.filter((row) => row.outcome !== "request_refused" && row.errorKind === "rate_limit").length;
      const latencies = list.filter((row) => row.outcome === "success").map((row) => row.latencyMs ?? Number.NaN);
      const reliable = providerSide >= minAttempts;
      return {
        providerId,
        attempts: list.length,
        successes,
        providerFailures,
        refused,
        providerSide,
        reliable,
        successRate: reliable ? rateOf(successes, providerSide) : null,
        rateLimitShare: rateOf(rateLimited, providerSide),
        medianLatencyMs: percentile(latencies, 50),
        p95LatencyMs: percentile(latencies, 95),
      };
    });
}

// --- Cost per master and per variant (Bible 14.2, 14.3, 15.3: from the ledger) ------------------------------------------------

/** A delivered video's cost as deliver wrote it (video.delivered). totalUsd is null when the stored cost could not be read. */
export type VideoCostRow = { requestId: string; videoId: string; variantOf: string | null; totalUsd: number | null };

/** The settled ledger of one request: its actual sum (null while any call is unsettled) and its estimate-flagged rows. */
export type LedgerRequestRow = { requestId: string; actualUsd: number | null; rows: number; unsettledRows: number };

export type CostSummary = {
  masters: CostDistribution;
  variants: CostDistribution;
  /** Delivered masters whose cost is unknown (no video.delivered, or an unreadable one). Counted, never priced at 0. */
  unknownMasters: number;
  /** Ledger rows whose actual is a list-price fallback or held estimate (Bible 14.1 step 4), not a provider bill. */
  /** Ledger rows with no bill: their cost is unknown, and no estimate stands in for it (contract v6). */
  unsettledRows: number;
  /** Requests whose ledger total equals the sum of their delivered videos. */
  reconciledRequests: number;
  mismatchedRequests: number;
  /** Requests with no settled ledger total or no delivered video to compare with. */
  unreconciledRequests: number;
};

export type CostDistribution = { count: number; meanUsd: number | null; p50Usd: number | null; p95Usd: number | null };

function costDistributionOf(values: readonly number[]): CostDistribution {
  const stats = distributionOf(values);
  return {
    count: stats.count,
    meanUsd: values.length === 0 ? null : roundUsd(sumUsd(values) / values.length),
    p50Usd: stats.p50 === null ? null : roundUsd(stats.p50),
    p95Usd: stats.p95 === null ? null : roundUsd(stats.p95),
  };
}

/**
 * The cost of masters and of variants from the delivered videos, plus a reconciliation of each request's settled ledger against the sum of
 * its delivered videos. deliver attributes every ledger row to a video, so the two must agree for a delivered request.
 */
export function costSummary(videos: readonly VideoCostRow[], ledger: readonly LedgerRequestRow[], unsettledRows: number): CostSummary {
  const masterCosts: number[] = [];
  const variantCosts: number[] = [];
  let unknownMasters = 0;
  const videosByRequest = new Map<string, number[]>();
  // A request with a delivered video whose cost is unknown cannot be reconciled: its total is incomplete by definition.
  const requestsWithUnknownVideo = new Set<string>();
  for (const video of videos) {
    if (video.variantOf === null) {
      if (video.totalUsd === null) unknownMasters += 1;
      else masterCosts.push(video.totalUsd);
    } else if (video.totalUsd !== null) {
      variantCosts.push(video.totalUsd);
    }
    if (video.totalUsd === null) {
      requestsWithUnknownVideo.add(video.requestId);
    } else {
      const list = videosByRequest.get(video.requestId) ?? [];
      list.push(video.totalUsd);
      videosByRequest.set(video.requestId, list);
    }
  }
  let reconciled = 0;
  let mismatched = 0;
  let unreconciled = 0;
  const ledgerRequests = new Set<string>();
  for (const row of ledger) {
    ledgerRequests.add(row.requestId);
    const videoTotals = videosByRequest.get(row.requestId);
    if (row.actualUsd === null || videoTotals === undefined || requestsWithUnknownVideo.has(row.requestId)) {
      unreconciled += 1;
    } else if (roundUsd(row.actualUsd) === roundUsd(sumUsd(videoTotals))) {
      reconciled += 1;
    } else {
      mismatched += 1;
    }
  }
  // A request with delivered videos but no settled ledger rows at all has nothing to compare with: it is unreconciled, not skipped.
  for (const requestId of new Set([...videosByRequest.keys(), ...requestsWithUnknownVideo])) {
    if (!ledgerRequests.has(requestId)) unreconciled += 1;
  }
  return {
    masters: costDistributionOf(masterCosts),
    variants: costDistributionOf(variantCosts),
    unknownMasters,
    unsettledRows,
    reconciledRequests: reconciled,
    mismatchedRequests: mismatched,
    unreconciledRequests: unreconciled,
  };
}

// --- Queue depth and age (Bible 15.3: queue depth and age per job type) -------------------------------------------------------

export type QueueRow = { jobType: string; status: string; createdAtMs: number };

export type QueueMetric = {
  jobType: string;
  queued: number;
  retrying: number;
  running: number;
  dead: number;
  /** Age in milliseconds of the oldest queued job at nowMs, or null when none is queued. */
  oldestQueuedMs: number | null;
};

export function queueSummary(rows: readonly QueueRow[], nowMs: number): QueueMetric[] {
  const byType = new Map<string, QueueMetric>();
  for (const row of rows) {
    const metric = byType.get(row.jobType) ?? { jobType: row.jobType, queued: 0, retrying: 0, running: 0, dead: 0, oldestQueuedMs: null };
    if (row.status === "queued") {
      metric.queued += 1;
      const age = nowMs - row.createdAtMs;
      metric.oldestQueuedMs = metric.oldestQueuedMs === null ? age : Math.max(metric.oldestQueuedMs, age);
    } else if (row.status === "retry") metric.retrying += 1;
    else if (row.status === "running") metric.running += 1;
    else if (row.status === "dead") metric.dead += 1;
    byType.set(row.jobType, metric);
  }
  return [...byType.values()].sort((a, b) => a.jobType.localeCompare(b.jobType));
}
