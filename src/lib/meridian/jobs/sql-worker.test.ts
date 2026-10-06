import assert from "node:assert/strict";
import test from "node:test";
import { claimAndRun, executeWithLease } from "./sql-worker.ts";
import type { ExecutableJob } from "./execute.ts";
import type { Sql } from "../learning/store.ts";

const job: ExecutableJob = {
  id: "job-1", organization_id: "org-1", brand_id: "brand-1", job_type: "market.normalize",
  payload: "{}", attempts: 0, max_attempts: 3,
};

test("a running job renews its lease while execution is still pending", async () => {
  let renewals = 0;
  const sql = (async (strings: TemplateStringsArray) => {
    if (strings.join(" ").includes("set lease_until")) renewals += 1;
    return [];
  }) as unknown as Sql;
  const result = await executeWithLease(sql, job, async () => {
    await new Promise((resolve) => setTimeout(resolve, 12));
    return "done";
  }, 2);
  assert.equal(result, "done");
  assert.ok(renewals >= 1);
});

test("claimAndRun schedules a retry using exponential backoff", async () => {
  const updates: string[] = [];
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    updates.push(query);
    if (query.includes("select id, organization_id")) return [{ ...job, attempts: 1 }];
    if (query.includes("returning id")) return [{ id: job.id }];
    return [];
  }) as unknown as Sql;
  const result = await claimAndRun(sql, job.id);
  assert.match(result, /^retry:/);
  assert.ok(updates.some((query) => query.includes("run_after = now() + (power(2")));
});
