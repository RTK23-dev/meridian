// The alert webhook through the gate the job executor gives it (jobs/execute.ts passes gatedTransport("alerts.webhook")). A configured
// webhook target is set, so the call reaches the gate. The test counts every request, asserts that none was sent, and asserts that the
// failure names the gate instead of claiming the target did not accept the alert.

import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { gatedTransport } from "../providers/capability.ts";
import { deliverAlert, type AlertEvent } from "./deliver.ts";

const GATE_MESSAGE = /off in this build, so nothing was sent/;

let requests: number;

beforeEach(() => {
  requests = 0;
  mock.method(globalThis, "fetch", (async () => {
    requests += 1;
    throw new Error("The alert default path reached the network.");
  }) as typeof fetch);
});

afterEach(() => {
  mock.restoreAll();
});

test("an alert to a configured webhook, refused by the alerts.webhook gate, fails with the gate's reason and sends no request", async () => {
  const alert: AlertEvent = {
    id: "alert_default_gate",
    organizationId: "org_default_gate",
    code: "budget_low",
    severity: "warning",
    detail: "The monthly budget is nearly used.",
    firstSeen: "2026-10-25T09:00:00.000Z",
    lastSeen: "2026-10-25T09:00:00.000Z",
    acknowledged: false,
  };
  const result = await deliverAlert(alert, { kind: "webhook", url: "https://hooks.example.test/alerts" }, gatedTransport("alerts.webhook"));
  assert.equal(result.status, "failed", "the alert is reported as not delivered");
  assert.match(result.error, GATE_MESSAGE, "the failure names the gate");
  assert.doesNotMatch(result.error, /did not accept/, "nothing was sent, so the target did not decline the alert");
  assert.equal(requests, 0, "no request is sent to the webhook");
});
