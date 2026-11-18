import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryPlan, MAX_DELIVERY_ATTEMPTS } from "./lifecycle.ts";

const target = { kind: "webhook" as const, url: "https://hooks.example.test/alerts" };

test("sent and uncertain end delivery; sending is not sent again; failed is retried up to the limit", () => {
  assert.deepEqual(deliveryPlan([{ status: "failed" }, { status: "sent" }], target), { action: "skip", status: "sent" });
  assert.deepEqual(deliveryPlan([{ status: "uncertain" }], target), { action: "skip", status: "uncertain" });
  assert.deepEqual(deliveryPlan([{ status: "failed" }, { status: "uncertain" }], target), { action: "skip", status: "uncertain" });
  assert.deepEqual(deliveryPlan([{ status: "sending" }], target), { action: "skip", status: "sending" });
  assert.deepEqual(deliveryPlan([{ status: "failed" }], target), { action: "send", status: "pending" });
  const exhausted = Array.from({ length: MAX_DELIVERY_ATTEMPTS }, () => ({ status: "failed" }));
  assert.deepEqual(deliveryPlan(exhausted, target), { action: "dead", status: "dead" });
});
