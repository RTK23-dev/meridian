// Operations alerts (Video Engine Bible 14.4, 15.3). Each rule is checked on a fixed snapshot and a fixed clock: a rule fires at its limit
// and not below it, and each alert names its kind, severity and reason code. The proposed thresholds are checked for their invariants.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { evaluateAlerts, type AlertSnapshot, type OpsAlert } from "./alerts.ts";
import { OPS_PROPOSAL_VERSION, proposedOpsThresholds, type OpsThresholds } from "./thresholds.ts";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function snapshot(overrides: Partial<AlertSnapshot> = {}): AlertSnapshot {
  return {
    nowMs: NOW,
    deadJobs: [],
    pausedDeadLetters: [],
    reservations: [],
    deliveredRequests: [],
    openBreakers: [],
    stuckRequests: [],
    gateEvaluations: [],
    ...overrides,
  };
}

function codes(alerts: readonly OpsAlert[]): string[] {
  return alerts.map((alert) => `${alert.kind}:${alert.reasonCode}`);
}

const thresholds: OpsThresholds = proposedOpsThresholds;

describe("budget overrun (Bible 14.1, 14.4)", () => {
  test("a reservation settled over its ceiling pages; at the ceiling it does not", () => {
    const over = evaluateAlerts(
      snapshot({ reservations: [{ organizationId: "ws_a", requestId: "req_1", reservationId: "res_1", ceilingUsd: 2, settledUsd: 2.5, unsettledRows: 0 }] }),
      thresholds,
    );
    assert.deepEqual(codes(over), ["budget_overrun:reservation_over_ceiling"]);
    assert.equal(over[0]?.severity, "page");
    assert.equal(over[0]?.measured, 2.5);
    assert.equal(over[0]?.limit, 2);

    const atCeiling = evaluateAlerts(
      snapshot({ reservations: [{ organizationId: "ws_a", requestId: "req_1", reservationId: "res_1", ceilingUsd: 2, settledUsd: 2, unsettledRows: 0 }] }),
      thresholds,
    );
    assert.deepEqual(atCeiling, []);
  });

  test("a format whose average real cost is over its estimate by more than the share warns, once it has enough requests in the day", () => {
    const delivered = (index: number, actualUsd: number | null, deliveredAtMs = NOW - HOUR) => ({
      organizationId: "ws_a",
      requestId: `req_${index}`,
      formatId: "fmt_x",
      estimateUsd: 2,
      actualUsd,
      deliveredAtMs,
    });
    const five = Array.from({ length: 5 }, (_, index) => delivered(index, 3));
    const alerts = evaluateAlerts(snapshot({ deliveredRequests: five }), thresholds);
    assert.deepEqual(codes(alerts), ["budget_overrun:format_average_over_estimate"]);
    assert.equal(alerts[0]?.severity, "warn");
    assert.equal(alerts[0]?.subject, "fmt_x");

    assert.deepEqual(evaluateAlerts(snapshot({ deliveredRequests: five.slice(0, 4) }), thresholds), [], "four requests are noise");
    const within = Array.from({ length: 5 }, (_, index) => delivered(index, 2.3));
    assert.deepEqual(evaluateAlerts(snapshot({ deliveredRequests: within }), thresholds), [], "15 per cent over is inside the 20 per cent share");
    const old = Array.from({ length: 5 }, (_, index) => delivered(index, 3, NOW - 25 * HOUR));
    assert.deepEqual(evaluateAlerts(snapshot({ deliveredRequests: old }), thresholds), [], "deliveries older than a day are not counted");
    const unsettled = Array.from({ length: 5 }, (_, index) => delivered(index, null));
    assert.deepEqual(evaluateAlerts(snapshot({ deliveredRequests: unsettled }), thresholds), [], "a request with an unsettled ledger is not averaged");
  });
});

describe("dead letters (Bible 5.3, 15.3)", () => {
  test("a dead letter open longer than its limit pages; a fresh one does not", () => {
    const stale = evaluateAlerts(
      snapshot({ pausedDeadLetters: [{ organizationId: "ws_a", requestId: "req_9", stage: "deliver", subjectId: "req_9", pausedAtMs: NOW - 20 * MINUTE }] }),
      thresholds,
    );
    assert.deepEqual(codes(stale), ["dead_letter_growth:open_dead_letter_over_limit"]);
    assert.equal(stale[0]?.severity, "page");
    assert.equal(stale[0]?.subject, "req_9");
    assert.deepEqual(
      evaluateAlerts(snapshot({ pausedDeadLetters: [{ organizationId: "ws_a", requestId: "req_9", stage: "deliver", subjectId: "req_9", pausedAtMs: NOW - 5 * MINUTE }] }), thresholds),
      [],
    );
  });

  test("dead jobs piling up in the growth window warn at the minimum count, and older dead jobs do not count", () => {
    const dead = (index: number, deadAtMs: number) => ({
      organizationId: "ws_a",
      jobId: `job_${index}`,
      requestId: `req_${index}`,
      stage: "render",
      deadAtMs,
      replayed: false,
    });
    const five = Array.from({ length: 5 }, (_, index) => dead(index, NOW - 10 * MINUTE));
    const growth = evaluateAlerts(snapshot({ deadJobs: five }), thresholds);
    assert.deepEqual(codes(growth), ["dead_letter_growth:dead_letter_growth"]);
    assert.equal(growth[0]?.severity, "warn");
    assert.equal(growth[0]?.measured, 5);
    assert.deepEqual(evaluateAlerts(snapshot({ deadJobs: five.slice(0, 4) }), thresholds), []);
    const old = Array.from({ length: 5 }, (_, index) => dead(index, NOW - 2 * HOUR));
    assert.deepEqual(evaluateAlerts(snapshot({ deadJobs: old }), thresholds), []);
  });
});

describe("provider breakers, stuck requests and gate pass rates (Bible 10.4, 15.3)", () => {
  test("an open breaker pages until it closes, and nothing is raised when the rule is off", () => {
    const open = { organizationId: "ws_a", providerId: "openrouter:x", trippedAtMs: NOW - MINUTE, openUntilMs: NOW + 5 * MINUTE };
    const alerts = evaluateAlerts(snapshot({ openBreakers: [open] }), thresholds);
    assert.deepEqual(codes(alerts), ["breaker_open:circuit_open"]);
    assert.equal(alerts[0]?.severity, "page");
    assert.equal(alerts[0]?.subject, "openrouter:x");
    assert.deepEqual(evaluateAlerts(snapshot({ openBreakers: [{ ...open, openUntilMs: NOW }] }), thresholds), []);
    const off: OpsThresholds = { ...thresholds, breaker: { alertWhenOpen: false } };
    assert.deepEqual(evaluateAlerts(snapshot({ openBreakers: [open] }), off), []);
  });

  test("a running request with no live job for its limit is stuck", () => {
    const stuck = evaluateAlerts(snapshot({ stuckRequests: [{ organizationId: "ws_a", requestId: "req_s", idleSinceMs: NOW - 31 * MINUTE }] }), thresholds);
    assert.deepEqual(codes(stuck), ["stuck_request:no_live_job"]);
    assert.equal(stuck[0]?.severity, "warn");
    assert.deepEqual(evaluateAlerts(snapshot({ stuckRequests: [{ organizationId: "ws_a", requestId: "req_s", idleSinceMs: NOW - 10 * MINUTE }] }), thresholds), []);
  });

  test("a gate whose recent pass rate drops by the points limit against its baseline warns, once each window has enough evaluations", () => {
    const evaluations = (count: number, passed: number, atMs: number) =>
      Array.from({ length: count }, (_, index) => ({ organizationId: "ws_a", gate: "take", passed: index < passed, atMs }));
    const drop = snapshot({ gateEvaluations: [...evaluations(20, 18, NOW - 3 * HOUR), ...evaluations(10, 5, NOW - 5 * MINUTE)] });
    const alerts = evaluateAlerts(drop, thresholds);
    assert.deepEqual(codes(alerts), ["gate_pass_drop:pass_rate_dropped"]);
    assert.equal(alerts[0]?.subject, "take");
    assert.equal(alerts[0]?.severity, "warn");

    const small = snapshot({ gateEvaluations: [...evaluations(20, 18, NOW - 3 * HOUR), ...evaluations(9, 5, NOW - 5 * MINUTE)] });
    assert.deepEqual(evaluateAlerts(small, thresholds), [], "nine recent evaluations are below the minimum");
    const slight = snapshot({ gateEvaluations: [...evaluations(20, 18, NOW - 3 * HOUR), ...evaluations(10, 8, NOW - 5 * MINUTE)] });
    assert.deepEqual(evaluateAlerts(slight, thresholds), [], "a drop of 10 points is inside the 20-point limit");
  });
});

describe("the alert list", () => {
  test("page alerts come before warnings, then by kind", () => {
    const alerts = evaluateAlerts(
      snapshot({
        stuckRequests: [{ organizationId: "ws_a", requestId: "req_s", idleSinceMs: NOW - 31 * MINUTE }],
        openBreakers: [{ organizationId: "ws_a", providerId: "p:m", trippedAtMs: NOW - MINUTE, openUntilMs: NOW + MINUTE }],
      }),
      thresholds,
    );
    assert.deepEqual(
      alerts.map((alert) => alert.severity),
      ["page", "warn"],
    );
    assert.equal(alerts[0]?.kind, "breaker_open");
  });

  test("the proposed thresholds carry their version and hold their invariants", () => {
    assert.equal(proposedOpsThresholds.version, OPS_PROPOSAL_VERSION);
    assert.ok(proposedOpsThresholds.gatePass.dropPoints > 0 && proposedOpsThresholds.gatePass.dropPoints <= 1);
    assert.ok(proposedOpsThresholds.budget.formatOverEstimateShare > 0);
    assert.ok(proposedOpsThresholds.budget.formatMinRequests >= 1);
    const { concurrency } = proposedOpsThresholds;
    assert.ok(concurrency.shrinkFactor > 0 && concurrency.shrinkFactor < 1);
    assert.ok(concurrency.growShare > 0 && concurrency.growShare <= 1);
    assert.ok(concurrency.rateLimitShareMax >= 0 && concurrency.rateLimitShareMax <= 1);
    for (const bounds of Object.values(concurrency.bounds)) {
      assert.ok(bounds.floor >= 1 && bounds.floor <= bounds.ceiling);
    }
  });
});
