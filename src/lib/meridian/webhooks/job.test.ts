import assert from "node:assert/strict";
import test from "node:test";
import { executeJob, type ExecutableJob } from "../jobs/execute.ts";
import type { Sql } from "../learning/store.ts";

// A webhook.received job only records; it must not touch the database, so the handle throws if it is used.
const untouched = (() => {
  throw new Error("The webhook job touched the database.");
}) as unknown as Sql;

function webhookJob(payload: Record<string, unknown>): ExecutableJob {
  return {
    id: "job-1",
    organization_id: "org-a",
    brand_id: null,
    job_type: "webhook.received",
    payload: JSON.stringify(payload),
    attempts: 1,
    max_attempts: 5,
  };
}

test("a webhook.received job reports that the event was recorded and that no downstream processing ran", async () => {
  const result = await executeJob(untouched, webhookJob({ eventId: "evt-1", provider: "meta" }));
  assert.equal(result, "recorded:evt-1:no-downstream-processing");
});

test("a webhook.received job with no event id fails instead of reporting a recording", async () => {
  await assert.rejects(executeJob(untouched, webhookJob({ provider: "meta" })), /Webhook job has no event id/);
});
