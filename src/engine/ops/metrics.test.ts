// Operations metrics as pure functions (Video Engine Bible 15.3, 19 E6). Each expected value is worked out from fixed rows here.
// An unknown input is counted as unknown, never as 0.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { costSummary, gatePassRates, providerHealth, queueSummary, stageSamples, summarizeStages, type StageEventRow, type VideoCostRow, type LedgerRequestRow } from "./metrics.ts";

function event(overrides: Partial<StageEventRow> & Pick<StageEventRow, "kind" | "atMs">): StageEventRow {
  return { requestId: "req_a", stage: "produce_shot", subjectId: "shot_1", jobId: "job_x", ...overrides };
}

describe("stage durations (Bible 15.3)", () => {
  test("a result is timed from the first submission of its attempt; a later submission does not restart the clock", () => {
    const events = [
      event({ kind: "submitted", atMs: 1_000, jobId: "job_1" }),
      event({ kind: "submitted", atMs: 1_500, jobId: "job_2" }),
      event({ kind: "stage.succeeded", atMs: 4_000, jobId: "job_3" }),
    ];
    const result = stageSamples(events, new Map());
    assert.deepEqual(result.samples, [{ requestId: "req_a", stage: "produce_shot", basis: "submit_to_result", ms: 3_000 }]);
    assert.equal(result.negative, 0);
  });

  test("without a submission, a result is timed from the start event of its job", () => {
    const events = [event({ kind: "stage.started", stage: "plan", subjectId: "req_a", jobId: "job_4", atMs: 2_000 }), event({ kind: "stage.succeeded", stage: "plan", subjectId: "req_a", jobId: "job_4", atMs: 2_600 })];
    assert.deepEqual(stageSamples(events, new Map()).samples, [{ requestId: "req_a", stage: "plan", basis: "started_to_result", ms: 600 }]);
  });

  test("with neither, a result is timed from the job's queue time, and not at all when that is unknown", () => {
    const done = event({ kind: "stage.succeeded", stage: "voice", subjectId: "req_a", jobId: "job_5", atMs: 1_500 });
    assert.deepEqual(stageSamples([done], new Map([["job_5", 500]])).samples, [{ requestId: "req_a", stage: "voice", basis: "queued_to_result", ms: 1_000 }]);
    assert.deepEqual(stageSamples([done], new Map()).samples, []);
  });

  test("a result that comes before its start is counted as a clock problem, never as a duration", () => {
    const done = event({ kind: "stage.succeeded", stage: "voice", subjectId: "req_a", jobId: "job_6", atMs: 8_000 });
    const result = stageSamples([done], new Map([["job_6", 9_000]]));
    assert.deepEqual(result.samples, []);
    assert.equal(result.negative, 1);
  });

  test("a dead stage closes its open submission, so a later result is timed from its own queue time", () => {
    const events = [
      event({ kind: "submitted", subjectId: "shot_2", atMs: 1_000, jobId: "job_7" }),
      event({ kind: "stage.dead", subjectId: "shot_2", atMs: 2_000, jobId: "job_7" }),
      event({ kind: "stage.succeeded", subjectId: "shot_2", atMs: 5_000, jobId: "job_8" }),
    ];
    assert.deepEqual(stageSamples(events, new Map([["job_8", 1_000]])).samples, [
      { requestId: "req_a", stage: "produce_shot", basis: "queued_to_result", ms: 4_000 },
    ]);
  });

  test("summaries keep the bases apart, sort by stage then basis, and give p50 and p95 per group", () => {
    const summary = summarizeStages([
      { requestId: "r", stage: "b", basis: "queued_to_result", ms: 10 },
      { requestId: "r", stage: "a", basis: "queued_to_result", ms: 5 },
      { requestId: "r", stage: "a", basis: "queued_to_result", ms: 15 },
      { requestId: "r", stage: "a", basis: "submit_to_result", ms: 100 },
    ]);
    assert.deepEqual(
      summary.map((item) => [item.stage, item.basis, item.count, item.p50Ms, item.p95Ms]),
      [
        ["a", "queued_to_result", 2, 5, 15],
        ["a", "submit_to_result", 1, 100, 100],
        ["b", "queued_to_result", 1, 10, 10],
      ],
    );
  });
});

describe("gate pass rates (Bible 15.3)", () => {
  test("rates by gate and by gate and format, with the counts behind each", () => {
    const rates = gatePassRates([
      { gate: "take", formatId: "f1", passed: true },
      { gate: "take", formatId: "f1", passed: false },
      { gate: "take", formatId: "f2", passed: true },
      { gate: "plan", formatId: "f1", passed: true },
    ]);
    assert.deepEqual(
      rates.byGate.map((rate) => [rate.gate, rate.total, rate.passed, rate.passRate]),
      [
        ["plan", 1, 1, 1],
        ["take", 3, 2, 0.6667],
      ],
    );
    assert.deepEqual(
      rates.byFormat.map((rate) => [rate.gate, rate.formatId, rate.passRate]),
      [
        ["plan", "f1", 1],
        ["take", "f1", 0.5],
        ["take", "f2", 1],
      ],
    );
  });
});

describe("provider health (Bible 10.2, 10.4)", () => {
  test("below the minimum sample the success rate is unknown, not 0 or 1; refusals are not the provider's failures", () => {
    const rows = [
      { providerId: "openrouter:x", outcome: "success" as const, errorKind: null, latencyMs: 100 },
      { providerId: "openrouter:x", outcome: "success" as const, errorKind: null, latencyMs: 200 },
      { providerId: "openrouter:x", outcome: "success" as const, errorKind: null, latencyMs: 300 },
      { providerId: "openrouter:x", outcome: "provider_failure" as const, errorKind: "rate_limit", latencyMs: null },
      { providerId: "openrouter:x", outcome: "request_refused" as const, errorKind: "content_policy", latencyMs: null },
    ];
    const [health] = providerHealth(rows, 10);
    assert.ok(health);
    assert.equal(health.attempts, 5);
    assert.equal(health.refused, 1);
    assert.equal(health.providerSide, 4);
    assert.equal(health.reliable, false);
    assert.equal(health.successRate, null);
    assert.equal(health.rateLimitShare, 0.25);
    assert.equal(health.medianLatencyMs, 200);
    assert.equal(health.p95LatencyMs, 300);
  });

  test("at the minimum sample the success rate is measured over the provider-side attempts only", () => {
    const successes = Array.from({ length: 8 }, () => ({ providerId: "fal:y", outcome: "success" as const, errorKind: null, latencyMs: 100 }));
    const failures = [
      { providerId: "fal:y", outcome: "provider_failure" as const, errorKind: "server", latencyMs: null },
      { providerId: "fal:y", outcome: "provider_failure" as const, errorKind: "server", latencyMs: null },
      { providerId: "fal:y", outcome: "request_refused" as const, errorKind: "invalid_input", latencyMs: null },
    ];
    const [health] = providerHealth([...successes, ...failures], 10);
    assert.ok(health);
    assert.equal(health.reliable, true);
    assert.equal(health.providerSide, 10);
    assert.equal(health.successRate, 0.8);
    assert.equal(health.rateLimitShare, 0);
  });
});

describe("cost per master and per variant (Bible 14.2, 14.3, 15.3)", () => {
  test("masters and variants are priced from the delivered videos, and each request's ledger is reconciled against them", () => {
    const videos: VideoCostRow[] = [
      { requestId: "r1", videoId: "v1", variantOf: null, totalUsd: 0.5 },
      { requestId: "r1", videoId: "v2", variantOf: "v1", totalUsd: 0.1 },
      { requestId: "r2", videoId: "v3", variantOf: null, totalUsd: null },
      { requestId: "r3", videoId: "v4", variantOf: null, totalUsd: 0.7 },
      { requestId: "r6", videoId: "v5", variantOf: null, totalUsd: 0.3 },
    ];
    const ledger: LedgerRequestRow[] = [
      { requestId: "r1", actualUsd: 0.6, rows: 2, unsettledRows: 0 },
      { requestId: "r2", actualUsd: 0.2, rows: 1, unsettledRows: 0 },
      { requestId: "r3", actualUsd: 0.9, rows: 3, unsettledRows: 0 },
      { requestId: "r4", actualUsd: 0.4, rows: 1, unsettledRows: 0 },
      { requestId: "r5", actualUsd: null, rows: 1, unsettledRows: 1 },
    ];
    const summary = costSummary(videos, ledger, 3);
    assert.deepEqual(summary.masters, { count: 3, meanUsd: 0.5, p50Usd: 0.5, p95Usd: 0.7 });
    assert.deepEqual(summary.variants, { count: 1, meanUsd: 0.1, p50Usd: 0.1, p95Usd: 0.1 });
    assert.equal(summary.unknownMasters, 1, "a master with an unreadable cost is counted, not priced at 0");
    assert.equal(summary.unsettledRows, 3, "three ledger rows have no bill: their cost is unknown");
    assert.equal(summary.reconciledRequests, 1, "r1: the ledger equals its two videos");
    assert.equal(summary.mismatchedRequests, 1, "r3: the ledger and its video differ");
    assert.equal(summary.unreconciledRequests, 4, "r2 (unknown cost), r4 (no video), r5 (unsettled), r6 (no ledger)");
  });
});

describe("queue depth and age (Bible 15.3)", () => {
  test("counts per job type and status, and the age of the oldest queued job", () => {
    const metrics = queueSummary(
      [
        { jobType: "engine.plan", status: "queued", createdAtMs: 1_000 },
        { jobType: "engine.plan", status: "queued", createdAtMs: 4_000 },
        { jobType: "engine.plan", status: "dead", createdAtMs: 500 },
        { jobType: "engine.compose", status: "retry", createdAtMs: 2_000 },
        { jobType: "engine.compose", status: "running", createdAtMs: 2_000 },
        { jobType: "engine.compose", status: "succeeded", createdAtMs: 2_000 },
      ],
      5_000,
    );
    assert.deepEqual(
      metrics.map((item) => [item.jobType, item.queued, item.retrying, item.running, item.dead, item.oldestQueuedMs]),
      [
        ["engine.compose", 0, 1, 1, 0, null],
        ["engine.plan", 2, 0, 0, 1, 4_000],
      ],
    );
  });
});
