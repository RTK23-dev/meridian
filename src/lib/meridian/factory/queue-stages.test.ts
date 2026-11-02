import assert from "node:assert/strict";
import test from "node:test";
import { FACTORY_GRAPH } from "./pipeline.ts";
import { queueStagesFrom } from "./queue-stages.ts";
import { FACTORY_TEST_BRAND, FACTORY_TEST_ORG, FACTORY_TEST_RUN, makeFactoryTestSql, seedFactoryRun } from "../../../test-support/lib/meridian/testing/factory-fixtures.ts";

const MANUAL = { automation: "manual" };

const RESUME = {
  organizationId: FACTORY_TEST_ORG,
  brandId: FACTORY_TEST_BRAND,
  runId: FACTORY_TEST_RUN,
  niche: "skincare",
  kind: "resume" as const,
  token: "t-resume-1",
};

test("a restarted run queues the stage it stopped at and every stage after it, each waiting on the one before it", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: MANUAL, level: 0 });
  const queued = await queueStagesFrom(sql, { ...RESUME, fromStage: "factory.produce" });
  const from = FACTORY_GRAPH.findIndex((spec) => spec.type === "factory.produce");
  assert.equal(queued, FACTORY_GRAPH.length - from);

  const rows = await sql<{ id: string; job_type: string; depends_on: string }>`
    select id, job_type, depends_on from jobs where idempotency_key like ${"%:resume:t-resume-1"} order by priority
  `;
  assert.equal(rows.length, queued);
  assert.equal(rows[0]?.job_type, "factory.produce", "the stop stage is queued first");
  assert.equal(rows[0]?.depends_on, "", "the stop stage waits on nothing: the stages before it already succeeded");
  for (let index = 1; index < rows.length; index += 1) {
    assert.equal(rows[index]?.depends_on, rows[index - 1]?.id, `${rows[index]?.job_type} waits on ${rows[index - 1]?.job_type}`);
  }
});

test("a repeated restart with the same token queues nothing new", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: MANUAL, level: 0 });
  const queued = await queueStagesFrom(sql, { ...RESUME, fromStage: "factory.launch" });
  await queueStagesFrom(sql, { ...RESUME, fromStage: "factory.launch" });
  const count = await sql<{ n: number }>`select count(*)::int as n from jobs where idempotency_key like ${"%:resume:t-resume-1"}`;
  assert.equal(count[0]?.n, queued, "the job keys are unique, so the second request is a no-op");
});

test("an approval and a restart are kept apart: the same stage queued by each has its own job keys", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: MANUAL, level: 0 });
  await queueStagesFrom(sql, { ...RESUME, fromStage: "factory.review", kind: "approval", token: "t-shared" });
  await queueStagesFrom(sql, { ...RESUME, fromStage: "factory.review", kind: "resume", token: "t-shared" });
  const count = await sql<{ n: number }>`select count(*)::int as n from jobs where idempotency_key like ${"%:t-shared"}`;
  assert.equal(count[0]?.n, (FACTORY_GRAPH.length - FACTORY_GRAPH.findIndex((spec) => spec.type === "factory.review")) * 2);
});
