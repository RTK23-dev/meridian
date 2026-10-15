// Operations alerts (Video Engine Bible 14.4, 15.3, 19 E6): typed, each with a reason. This file is pure: it takes a snapshot of the
// engine's state (alerts-sql.ts reads it) and the thresholds (ops/thresholds.ts, proposed), and returns the alerts that hold. It does not
// page anyone; the lead decides where alerts go. A reason is built from measured numbers and rule names, never from model or provider text.
//
// Kinds: budget_overrun (a reservation spent over its ceiling, or a format's average real cost over its estimate), dead_letter_growth (a
// stage died, its request paused, and dead jobs are piling up, or an open dead letter is older than the limit), breaker_open (a provider's
// circuit is open), stuck_request (a running request has no live job), gate_pass_drop (a gate's pass rate fell over the limit).

import { roundUsd, sumUsd } from "../contracts/index.ts";
import { rateOf } from "./distribution.ts";
import type { OpsThresholds } from "./thresholds.ts";

export const OPS_ALERT_SCHEMA = "meridian.ops_alert/v1" as const;

export const OPS_ALERT_KINDS = ["budget_overrun", "dead_letter_growth", "breaker_open", "stuck_request", "gate_pass_drop"] as const;
export type OpsAlertKind = (typeof OPS_ALERT_KINDS)[number];

/** page: someone is needed now. warn: someone should look today. The lead maps these to channels. */
export type OpsAlertSeverity = "page" | "warn";

export type OpsAlert = {
  schema: typeof OPS_ALERT_SCHEMA;
  kind: OpsAlertKind;
  severity: OpsAlertSeverity;
  organizationId: string;
  /** What the alert is about: a request id, a provider id, a format id, or a gate name. */
  subject: string;
  /** A short machine code for the reason (for example reservation_over_ceiling). */
  reasonCode: string;
  /** One sentence, built from the measured numbers in the snapshot. */
  reason: string;
  measured: number | null;
  limit: number | null;
  raisedAt: string;
};

export type AlertSnapshot = {
  nowMs: number;
  /** Dead engine jobs in the look-back window. replayed is true once a replay of the job was applied. */
  deadJobs: { organizationId: string; jobId: string; requestId: string; stage: string | null; deadAtMs: number; replayed: boolean }[];
  /** Requests paused on a dead letter that has not been replayed, with the time the stage died. */
  pausedDeadLetters: { organizationId: string; requestId: string; stage: string; subjectId: string; pausedAtMs: number }[];
  /** Each reservation: its ceiling (estimate plus redo allowance, Bible 14.1), the settled sum of its ledger rows, and how many are unsettled. */
  reservations: { organizationId: string; requestId: string; reservationId: string; ceilingUsd: number; settledUsd: number; unsettledRows: number }[];
  /** Delivered requests with the estimate of their released reservations and the settled sum of their ledgers (null while unsettled). */
  deliveredRequests: { organizationId: string; requestId: string; formatId: string; estimateUsd: number; actualUsd: number | null; deliveredAtMs: number }[];
  /** Provider circuits that are open at nowMs. */
  openBreakers: { organizationId: string; providerId: string; trippedAtMs: number; openUntilMs: number }[];
  /** Running requests with no queued, running or retrying engine job. */
  stuckRequests: { organizationId: string; requestId: string; idleSinceMs: number }[];
  /** Stored gate results since the start of the baseline window. */
  gateEvaluations: { organizationId: string; gate: string; passed: boolean; atMs: number }[];
};

const MINUTE_MS = 60_000;
const EPSILON_USD = 0.00005;

function alertOf(input: Omit<OpsAlert, "schema" | "raisedAt">, nowMs: number): OpsAlert {
  return { schema: OPS_ALERT_SCHEMA, raisedAt: new Date(nowMs).toISOString(), ...input };
}

/** The alerts that hold for the snapshot, sorted by severity (page first), then kind, organization and subject. */
export function evaluateAlerts(snapshot: AlertSnapshot, thresholds: OpsThresholds): OpsAlert[] {
  const alerts: OpsAlert[] = [
    ...reservationAlerts(snapshot),
    ...formatAlerts(snapshot, thresholds),
    ...deadLetterAlerts(snapshot, thresholds),
    ...breakerAlerts(snapshot, thresholds),
    ...stuckAlerts(snapshot, thresholds),
    ...gatePassAlerts(snapshot, thresholds),
  ];
  const rank: Record<OpsAlertSeverity, number> = { page: 0, warn: 1 };
  return alerts.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      a.kind.localeCompare(b.kind) ||
      a.organizationId.localeCompare(b.organizationId) ||
      a.subject.localeCompare(b.subject),
  );
}

/** Bible 14.1: a reservation spent over its ceiling is a defect in cap mode (a call beyond the reservation is refused). Hard limit. */
function reservationAlerts(snapshot: AlertSnapshot): OpsAlert[] {
  const out: OpsAlert[] = [];
  for (const reservation of snapshot.reservations) {
    if (roundUsd(reservation.settledUsd) <= roundUsd(reservation.ceilingUsd) + EPSILON_USD) continue;
    out.push(
      alertOf(
        {
          kind: "budget_overrun",
          severity: "page",
          organizationId: reservation.organizationId,
          subject: reservation.requestId,
          reasonCode: "reservation_over_ceiling",
          reason: `settled spend ${roundUsd(reservation.settledUsd)} USD is over the reservation ceiling of ${roundUsd(reservation.ceilingUsd)} USD`,
          measured: roundUsd(reservation.settledUsd),
          limit: roundUsd(reservation.ceilingUsd),
        },
        snapshot.nowMs,
      ),
    );
  }
  return out;
}

/** Bible 14.4: a format's average real cost over its estimate by more than the share, for a day. Needs a minimum of requests. */
function formatAlerts(snapshot: AlertSnapshot, thresholds: OpsThresholds): OpsAlert[] {
  const windowStart = snapshot.nowMs - thresholds.budget.formatWindowMs;
  const groups = new Map<string, { organizationId: string; formatId: string; actual: number[]; estimate: number[] }>();
  for (const request of snapshot.deliveredRequests) {
    if (request.deliveredAtMs < windowStart || request.actualUsd === null) continue;
    const key = `${request.organizationId}|${request.formatId}`;
    const group = groups.get(key) ?? { organizationId: request.organizationId, formatId: request.formatId, actual: [], estimate: [] };
    group.actual.push(request.actualUsd);
    group.estimate.push(request.estimateUsd);
    groups.set(key, group);
  }
  const out: OpsAlert[] = [];
  for (const group of groups.values()) {
    if (group.actual.length < thresholds.budget.formatMinRequests) continue;
    const averageActual = sumUsd(group.actual) / group.actual.length;
    const averageEstimate = sumUsd(group.estimate) / group.estimate.length;
    if (!(averageEstimate > 0)) continue;
    const limit = averageEstimate * (1 + thresholds.budget.formatOverEstimateShare);
    if (averageActual <= limit) continue;
    const over = rateOf(averageActual - averageEstimate, averageEstimate);
    out.push(
      alertOf(
        {
          kind: "budget_overrun",
          severity: "warn",
          organizationId: group.organizationId,
          subject: group.formatId,
          reasonCode: "format_average_over_estimate",
          reason: `format ${group.formatId} averages ${roundUsd(averageActual)} USD real cost over ${group.actual.length} delivered requests, ${over === null ? "over" : `${Math.round(over * 100)}%`} above its ${roundUsd(averageEstimate)} USD estimate`,
          measured: roundUsd(averageActual),
          limit: roundUsd(limit),
        },
        snapshot.nowMs,
      ),
    );
  }
  return out;
}

/** Bible 15.3: a dead-letter queue above zero for 15 minutes; a stage that stays dead pages. Growth is a count of new dead jobs. */
function deadLetterAlerts(snapshot: AlertSnapshot, thresholds: OpsThresholds): OpsAlert[] {
  const out: OpsAlert[] = [];
  const openLimitMs = thresholds.deadLetter.openMinutes * MINUTE_MS;
  for (const paused of snapshot.pausedDeadLetters) {
    const openMs = snapshot.nowMs - paused.pausedAtMs;
    if (openMs < openLimitMs) continue;
    out.push(
      alertOf(
        {
          kind: "dead_letter_growth",
          severity: "page",
          organizationId: paused.organizationId,
          subject: paused.requestId,
          reasonCode: "open_dead_letter_over_limit",
          reason: `stage ${paused.stage} has been dead for ${Math.round(openMs / MINUTE_MS)} minutes with no replay, over ${thresholds.deadLetter.openMinutes} minutes`,
          measured: Math.round(openMs / MINUTE_MS),
          limit: thresholds.deadLetter.openMinutes,
        },
        snapshot.nowMs,
      ),
    );
  }
  const growthStart = snapshot.nowMs - thresholds.deadLetter.growthWindowMinutes * MINUTE_MS;
  const newDead = new Map<string, number>();
  for (const job of snapshot.deadJobs) {
    if (job.deadAtMs < growthStart) continue;
    newDead.set(job.organizationId, (newDead.get(job.organizationId) ?? 0) + 1);
  }
  for (const [organizationId, count] of newDead) {
    if (count < thresholds.deadLetter.growthMinNew) continue;
    out.push(
      alertOf(
        {
          kind: "dead_letter_growth",
          severity: "warn",
          organizationId,
          subject: organizationId,
          reasonCode: "dead_letter_growth",
          reason: `${count} engine jobs died in the last ${thresholds.deadLetter.growthWindowMinutes} minutes, at or above ${thresholds.deadLetter.growthMinNew}`,
          measured: count,
          limit: thresholds.deadLetter.growthMinNew,
        },
        snapshot.nowMs,
      ),
    );
  }
  return out;
}

/** Bible 15.3: any provider circuit open. */
function breakerAlerts(snapshot: AlertSnapshot, thresholds: OpsThresholds): OpsAlert[] {
  if (!thresholds.breaker.alertWhenOpen) return [];
  return snapshot.openBreakers
    .filter((breaker) => breaker.openUntilMs > snapshot.nowMs)
    .map((breaker) =>
      alertOf(
        {
          kind: "breaker_open",
          severity: "page",
          organizationId: breaker.organizationId,
          subject: breaker.providerId,
          reasonCode: "circuit_open",
          reason: `provider ${breaker.providerId} is skipped until ${new Date(breaker.openUntilMs).toISOString()} (tripped ${new Date(breaker.trippedAtMs).toISOString()})`,
          measured: null,
          limit: null,
        },
        snapshot.nowMs,
      ),
    );
}

/** A running request with no live job and no activity for the limit will not move on its own. */
function stuckAlerts(snapshot: AlertSnapshot, thresholds: OpsThresholds): OpsAlert[] {
  const limitMs = thresholds.stuck.noLiveJobMinutes * MINUTE_MS;
  return snapshot.stuckRequests
    .filter((request) => snapshot.nowMs - request.idleSinceMs >= limitMs)
    .map((request) =>
      alertOf(
        {
          kind: "stuck_request",
          severity: "warn",
          organizationId: request.organizationId,
          subject: request.requestId,
          reasonCode: "no_live_job",
          reason: `request is running with no queued, running or retrying job, idle for ${Math.round((snapshot.nowMs - request.idleSinceMs) / MINUTE_MS)} minutes`,
          measured: Math.round((snapshot.nowMs - request.idleSinceMs) / MINUTE_MS),
          limit: thresholds.stuck.noLiveJobMinutes,
        },
        snapshot.nowMs,
      ),
    );
}

/** Bible 15.3: a gate's pass rate drops by the points limit in the recent window against the baseline before it. Each window needs a minimum. */
function gatePassAlerts(snapshot: AlertSnapshot, thresholds: OpsThresholds): OpsAlert[] {
  const recentStart = snapshot.nowMs - thresholds.gatePass.recentWindowMinutes * MINUTE_MS;
  const baselineStart = recentStart - thresholds.gatePass.baselineWindowMinutes * MINUTE_MS;
  const cells = new Map<string, { organizationId: string; gate: string; recent: [number, number]; baseline: [number, number] }>();
  for (const evaluation of snapshot.gateEvaluations) {
    let window: "recent" | "baseline" | null = null;
    if (evaluation.atMs >= recentStart && evaluation.atMs <= snapshot.nowMs) window = "recent";
    else if (evaluation.atMs >= baselineStart && evaluation.atMs < recentStart) window = "baseline";
    if (window === null) continue;
    const key = `${evaluation.organizationId}|${evaluation.gate}`;
    const cell = cells.get(key) ?? { organizationId: evaluation.organizationId, gate: evaluation.gate, recent: [0, 0], baseline: [0, 0] };
    const counts = cell[window];
    counts[0] += 1;
    if (evaluation.passed) counts[1] += 1;
    cells.set(key, cell);
  }
  const out: OpsAlert[] = [];
  for (const cell of cells.values()) {
    const minimum = thresholds.gatePass.minEvaluations;
    if (cell.recent[0] < minimum || cell.baseline[0] < minimum) continue;
    const recentRate = rateOf(cell.recent[1], cell.recent[0]);
    const baselineRate = rateOf(cell.baseline[1], cell.baseline[0]);
    if (recentRate === null || baselineRate === null) continue;
    const drop = Math.round((baselineRate - recentRate) * 10_000) / 10_000;
    if (drop < thresholds.gatePass.dropPoints) continue;
    out.push(
      alertOf(
        {
          kind: "gate_pass_drop",
          severity: "warn",
          organizationId: cell.organizationId,
          subject: cell.gate,
          reasonCode: "pass_rate_dropped",
          reason: `gate ${cell.gate} passed ${Math.round(recentRate * 100)}% of ${cell.recent[0]} recent evaluations, down ${Math.round(drop * 100)} points from ${Math.round(baselineRate * 100)}%`,
          measured: recentRate,
          limit: Math.round((baselineRate - thresholds.gatePass.dropPoints) * 10_000) / 10_000,
        },
        snapshot.nowMs,
      ),
    );
  }
  return out;
}
