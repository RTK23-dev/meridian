import assert from "node:assert/strict";
import test from "node:test";
import { heartbeatCopy, hasActiveJob, durationLabel, jobActionState, pageSpan } from "./jobs-model.ts";
import { formatCostCents, barPercent } from "./usage-model.ts";
import { dateRangeProblem, auditDetailsText } from "./audit-model.ts";
import { decisionControls, changeText, baselineCopy } from "./calibration-model.ts";
import { targetCopy, deliveryCopy } from "./alerts-model.ts";
import type { Baseline, ThresholdChange, CalibrationProposalView } from "../../lib/meridian/calibration/versions.ts";

// The screen models are pure. Each test states what the screen shows for one input, so a regression in the wording or the
// rule fails here and not in a browser.

test("jobs: a heartbeat reads running or stopped by the server's 30-second rule, and a missing age is never shown as zero", () => {
  assert.deepEqual(heartbeatCopy({ state: "running", ageSeconds: null }), {
    value: "Running",
    healthy: true,
    detail: "A heartbeat arrived within the last 30 seconds.",
  });
  assert.equal(heartbeatCopy({ state: "running", ageSeconds: 12 }).detail, "Last heartbeat 12 s ago.");
  assert.equal(heartbeatCopy({ state: "stopped", ageSeconds: null }).detail, "No heartbeat has been recorded.");
  assert.equal(heartbeatCopy({ state: "stopped", ageSeconds: 180 }).healthy, false);
  assert.match(heartbeatCopy({ state: "stopped", ageSeconds: 180 }).detail, /Last heartbeat 3 min ago/);
  assert.doesNotMatch(heartbeatCopy({ state: "stopped", ageSeconds: null }).detail, /\b0 s\b/);
});

test("jobs: the retry and cancel actions need an admin and a state that allows them", () => {
  const job = { canRetry: true, canCancel: true, cancelRequested: false };
  assert.deepEqual(jobActionState(job, true), { retry: true, cancel: true, cancelNote: null });
  assert.deepEqual(jobActionState(job, false), { retry: false, cancel: false, cancelNote: null });
  assert.equal(jobActionState({ ...job, cancelRequested: true }, true).cancelNote, "Cancellation requested. The worker stops it on its next pass.");
  assert.deepEqual(jobActionState({ canRetry: false, canCancel: false, cancelRequested: false }, true), { retry: false, cancel: false, cancelNote: null });
});

test("jobs: a duration is unknown when it is null, missing or negative, and is never estimated", () => {
  assert.equal(durationLabel(null), "Unknown");
  assert.equal(durationLabel(undefined), "Unknown");
  assert.equal(durationLabel(Number.NaN), "Unknown");
  assert.equal(durationLabel(-5), "Unknown");
  assert.equal(durationLabel(2_500), "2.5 s");
});

test("jobs: a job is active only while it is queued, running or retrying", () => {
  assert.equal(hasActiveJob([{ status: "succeeded" }, { status: "dead" }]), false);
  assert.equal(hasActiveJob([{ status: "succeeded" }, { status: "retry" }]), true);
  assert.equal(hasActiveJob([]), false);
});

test("jobs: a page span shows the first and last row, and at least one page even when empty", () => {
  assert.deepEqual(pageSpan(0, 50, 0), { first: 0, last: 0, pageCount: 1 });
  assert.deepEqual(pageSpan(1, 50, 120), { first: 51, last: 100, pageCount: 3 });
  assert.deepEqual(pageSpan(2, 50, 120), { first: 101, last: 120, pageCount: 3 });
});

test("usage: a cost that is not known reads as unknown, never as $0.00", () => {
  assert.equal(formatCostCents(null), "Cost unknown");
  assert.equal(formatCostCents(undefined), "Cost unknown");
  assert.equal(formatCostCents(Number.NaN), "Cost unknown");
  assert.equal(formatCostCents(0), "$0.00", "a recorded zero is still shown as zero");
  assert.equal(formatCostCents(1234), "$12.34");
});

test("usage: a bar is drawn only from a known value and a positive maximum", () => {
  assert.equal(barPercent(null, 10), null);
  assert.equal(barPercent(5, null), null);
  assert.equal(barPercent(5, 0), null, "a zero maximum draws no bar");
  assert.equal(barPercent(5, 10), 50);
  assert.equal(barPercent(20, 10), 100, "a bar is capped at full width");
  assert.equal(barPercent(-1, 10), 0);
});

test("audit: a start date after the end date is refused, and an open range is not", () => {
  assert.match(dateRangeProblem("2026-10-12", "2026-10-01") ?? "", /start date is after the end date/);
  assert.equal(dateRangeProblem("2026-10-01", "2026-10-12"), null);
  assert.equal(dateRangeProblem("", "2026-10-01"), null);
  assert.equal(dateRangeProblem("2026-10-01", ""), null);
});

test("audit: the details line carries key and value pairs with the known secret forms removed and the line clipped", () => {
  assert.equal(auditDetailsText({}), "");
  const text = auditDetailsText({ action: "keys.saved", callback: "access_token=abc123secret&state=ok", header: "Bearer xyz987token" });
  assert.match(text, /action: keys\.saved/);
  assert.equal(text.includes("abc123secret"), false, "an access token in a query string is removed");
  assert.equal(text.includes("xyz987token"), false, "a bearer token is removed");
  assert.match(text, /access_token=redacted/);
  const long = auditDetailsText({ note: "x".repeat(400) });
  assert.ok(long.length <= 240, "the line is clipped to 240 characters");
});

const approvedBaseline: Baseline = { source: "approved", version: 3, thresholds: { autoApprove: 0.9, humanReview: 0.3 } };
const codeBaseline: Baseline = { source: "code_default", version: null, thresholds: { autoApprove: 0.88, humanReview: 0.28 } };
const unreadableBaseline: Baseline = { source: "unreadable", version: 2, thresholds: { autoApprove: 0.88, humanReview: 0.28 } };
const CODE_DEFAULT = { autoApprove: 0.88, humanReview: 0.28 };

test("calibration: the baseline says which version is active, or that the code default is, or that a version cannot be read", () => {
  assert.equal(baselineCopy(approvedBaseline, CODE_DEFAULT).title, "Version 3 is active");
  assert.equal(baselineCopy(approvedBaseline, CODE_DEFAULT).warning, false);
  assert.equal(baselineCopy(codeBaseline, CODE_DEFAULT).title, "No approved version. The code defaults are active.");
  const unreadable = baselineCopy(unreadableBaseline, CODE_DEFAULT);
  assert.equal(unreadable.title, "Version 2 cannot be read");
  assert.equal(unreadable.warning, true);
  assert.match(unreadable.detail, /uses the code defaults until a readable version exists/);
});

test("calibration: a change is a signed number, or No change when the proposed value equals the baseline", () => {
  const same: ThresholdChange = { field: "autoApprove", baseline: 0.88, proposed: 0.88, change: 0, changed: false };
  const up: ThresholdChange = { field: "autoApprove", baseline: 0.88, proposed: 0.91, change: 0.03, changed: true };
  const down: ThresholdChange = { field: "humanReview", baseline: 0.28, proposed: 0.22, change: -0.06, changed: true };
  assert.equal(changeText(same), "No change");
  assert.equal(changeText(up), "+0.030");
  assert.equal(changeText(down), "-0.060");
});

test("calibration: only a waiting proposal can be decided, only an admin decides, and an unreadable proposal can be rejected but not approved", () => {
  const waiting = { canDecide: true, changes: [] } as unknown as Pick<CalibrationProposalView, "canDecide" | "changes">;
  assert.deepEqual(decisionControls(waiting, true), { approve: true, reject: true, note: null });
  assert.deepEqual(decisionControls({ canDecide: false, changes: [] } as never, true), { approve: false, reject: false, note: null });
  assert.equal(decisionControls(waiting, false).approve, false);
  assert.match(decisionControls(waiting, false).note ?? "", /Only an admin can approve or reject/);
  const unreadable = { canDecide: true, changes: null } as unknown as Pick<CalibrationProposalView, "canDecide" | "changes">;
  assert.deepEqual(decisionControls(unreadable, true).approve, false);
  assert.equal(decisionControls(unreadable, true).reject, true);
});

test("alerts: a target is connected only when a webhook is saved, and the copy says delivery needs the endpoint to accept it", () => {
  assert.equal(targetCopy("webhook configured").connected, true);
  assert.match(targetCopy("webhook configured").text, /counts as delivered only after the endpoint accepts it/);
  assert.equal(targetCopy("not configured").connected, false);
  assert.equal(targetCopy("anything else").connected, false, "an unknown target is treated as not connected");
});

test("alerts: a delivery is described as delivered only once the endpoint accepted it", () => {
  assert.equal(deliveryCopy("sent"), "Delivered. The webhook endpoint accepted it.");
  assert.equal(deliveryCopy("pending"), "Waiting for the worker to send it to the saved target.");
  assert.equal(deliveryCopy("not_configured"), "Not delivered. No webhook target is saved.");
  assert.equal(deliveryCopy("dead"), "Not delivered. Sending stopped after repeated failures.");
  assert.equal(deliveryCopy(""), "Delivery status is not recorded.");
  assert.doesNotMatch(deliveryCopy("pending"), /Delivered/);
});
