import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceBudgetFromSettings } from "./workspace-budget.ts";

const scope = { organizationId: "org_1", requestId: "req_1", now: "2026-10-14T20:00:00.000Z" };

test("a budget set in Settings is known", async () => {
  const source = workspaceBudgetFromSettings(async () => 250);
  assert.deepEqual(await source.monthBudget(scope), { status: "known", usd: 250 });
});

test("an unset budget is not connected and names where to set it, never a number", async () => {
  const result = await workspaceBudgetFromSettings(async () => null).monthBudget(scope);
  assert.equal(result.status, "not_connected");
  assert.match(result.status === "not_connected" ? result.reason : "", /Monthly video budget \(USD\)/);
});

test("a read that fails is not connected", async () => {
  const result = await workspaceBudgetFromSettings(async () => Promise.reject(new Error("db down"))).monthBudget(scope);
  assert.equal(result.status, "not_connected");
});

test("the reader is asked for the request's own workspace", async () => {
  const asked: string[] = [];
  await workspaceBudgetFromSettings(async (organizationId) => {
    asked.push(organizationId);
    return 10;
  }).monthBudget(scope);
  assert.deepEqual(asked, ["org_1"]);
});
