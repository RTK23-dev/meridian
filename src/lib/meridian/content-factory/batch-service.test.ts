// A batch of Content Factory videos (prompt 15), on PGlite with every migration. A batch is made of draft videos of one brand. Its start stops at
// the budget and keeps the rest as draft with the reason. A retry is for one failed item: its siblings do not change. Refusals change nothing.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { advance } from "../../../engine/jobs/orchestrator.ts";
import { createBatch, getBatch, retryBatchItem, startBatch } from "./batch-service.ts";

const WS = "org_batch_service";
const BRAND = "brand_batch_service";
const ADMIN = "user_batch_admin";
const MEMBER = "user_batch_member";

let db: TestDatabase;

/** The state the engine writes when a request starts. A fixture changes only what the status reader looks at: intake, or the manifest. */
function startedState(requestId: string): Record<string, unknown> {
  const started = advance(null, { type: "start", organizationId: WS, requestId, priority: "normal", cachedDna: false, variantCount: 0, requestArtifactId: "art_batch" });
  return JSON.parse(JSON.stringify(started.state)) as Record<string, unknown>;
}

function withIntakePassed(state: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const nodes = state.nodes as Record<string, Record<string, unknown>>;
  return { ...state, ...extra, nodes: { ...nodes, intake: { ...nodes.intake, status: "passed" } } };
}

async function request(id: string, status: string, state: Record<string, unknown>, stage: string): Promise<void> {
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state, current_stage)
    values (${id}, ${WS}, ${BRAND}, 'fmt_batch', 'normal', ${status}, ${JSON.stringify(state)}, ${stage})
  `;
}

async function video(id: string, status: string, budget: number | null, requestId: string | null, revision = 0): Promise<void> {
  await db.sql`
    insert into content_factory_sessions (id, organization_id, brand_id, created_by, title, status, engine_request_id, started_at, budget_usd, revision)
    values (${id}, ${WS}, ${BRAND}, ${ADMIN}, ${`Video ${id}`}, ${status}, ${requestId}, ${status === "started" ? new Date() : null}, ${budget}, ${revision})
  `;
}

async function statusOf(id: string): Promise<{ status: string; revision: number; lastRefusal: string }> {
  const [row] = await db.sql<{ status: string; revision: number; last_refusal: string }>`
    select status, revision, last_refusal from content_factory_sessions where id = ${id}
  `;
  return { status: row?.status ?? "missing", revision: Number(row?.revision ?? -1), lastRefusal: row?.last_refusal ?? "" };
}

// createBatch takes draft videos only, by design. A batch that already holds a started video (the case a start or a retry works on) is seeded
// here, row by row, so the start and retry logic is exercised on the state a real batch reaches.
let batchSeq = 0;
async function seedBatch(title: string, budget: number, sessionIds: string[]): Promise<string> {
  batchSeq += 1;
  const id = `batch_seed_${batchSeq}`;
  await db.sql`insert into content_factory_batches (id, organization_id, brand_id, title, budget_usd, created_by) values (${id}, ${WS}, ${BRAND}, ${title}, ${budget}, ${ADMIN})`;
  for (const [position, sessionId] of sessionIds.entries()) {
    await db.sql`insert into content_factory_batch_items (id, organization_id, batch_id, session_id, position) values (${`item_${id}_${position}`}, ${WS}, ${id}, ${sessionId}, ${position})`;
  }
  return id;
}

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  for (const [id, role] of [[ADMIN, "admin"], [MEMBER, "member"]] as const) {
    await db.sql`insert into "user" (id, name, email, "emailVerified") values (${id}, ${id}, ${`${id}@fixture.example`}, true)`;
    await db.sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${id}`}, ${WS}, ${id}, ${role})`;
  }
  // Engine requests: running (intake passed), delivered (with a manifest), rejected at intake, and queued (intake not passed yet).
  await request("req_b_run", "running", withIntakePassed(startedState("req_b_run")), "plan");
  await request("req_b_del", "delivered", withIntakePassed(startedState("req_b_del"), { manifestId: "man_b_1" }), "deliver");
  await request("req_b_fail", "rejected", startedState("req_b_fail"), "intake");
  // The engine stores a request as 'running' until intake passes; the status 'queued' is read from that, not stored.
  await request("req_b_queued", "running", startedState("req_b_queued"), "intake");
  await video("v_draft_a", "draft", 10, null);
  await video("v_draft_b", "draft", 10, null);
  await video("v_draft_nobudget", "draft", null, null);
  await video("v_draft_cap", "draft", 10, null);
  await video("v_draft_after", "draft", 10, null);
  await video("v_running", "started", 10, "req_b_run");
  await video("v_failed", "started", 10, "req_b_fail", 0);
  await video("v_delivered", "started", 10, "req_b_del");
  await video("v_queued", "started", 10, "req_b_queued");
  // Each batch test needs its own videos: a video belongs to one batch only.
  // A request belongs to one video, so each extra video has its own.
  await request("req_b_run2", "running", withIntakePassed(startedState("req_b_run2")), "plan");
  await request("req_b_fail2", "rejected", startedState("req_b_fail2"), "intake");
  await video("v_running2", "started", 10, "req_b_run2");
  await video("v_failed2", "started", 10, "req_b_fail2", 0);
});

after(async () => {
  await db.close();
});

test("a batch is made of draft videos of one brand, under one budget, and a video joins one batch only", async () => {
  await assert.rejects(createBatch(db.sql, ADMIN, { brandId: BRAND, title: "  ", budgetUsd: 20, sessionIds: ["v_draft_a"] }), /Give the batch a name/);
  await assert.rejects(createBatch(db.sql, ADMIN, { brandId: BRAND, title: "Spring", budgetUsd: 0, sessionIds: ["v_draft_a"] }), /positive amount/);
  await assert.rejects(createBatch(db.sql, ADMIN, { brandId: BRAND, title: "Spring", budgetUsd: 20, sessionIds: ["v_running"] }), /Only a draft video/);
  await assert.rejects(createBatch(db.sql, MEMBER, { brandId: BRAND, title: "Spring", budgetUsd: 20, sessionIds: ["v_draft_a"] }));

  const made = await createBatch(db.sql, ADMIN, { brandId: BRAND, title: "Spring", budgetUsd: 20, sessionIds: ["v_draft_a", "v_draft_b"] });
  assert.deepEqual(made.items.map((item) => item.sessionId), ["v_draft_a", "v_draft_b"], "items keep the order they were given");
  assert.deepEqual(made.items.map((item) => item.state), ["ready", "ready"]);
  assert.equal(made.committedUsd, 0, "nothing is committed before a start");
  await assert.rejects(createBatch(db.sql, ADMIN, { brandId: BRAND, title: "Again", budgetUsd: 20, sessionIds: ["v_draft_a"] }), /one batch only/);
  const [audit] = await db.sql<{ n: string }>`select count(*)::text as n from audit_log where object_id = ${made.id} and action = 'content_factory.batch_created'`;
  assert.equal(audit?.n, "1");
});

test("a start stops at the batch budget: the video that would pass it and the ones after it stay draft, with the reason", async () => {
  // The started video counts toward the committed spend (10), so a second video of 10 under a budget of 15 would pass it.
  const batchId = await seedBatch("Capped", 15, ["v_running", "v_draft_cap", "v_draft_after"]);
  const before = await getBatch(db.sql, ADMIN, { batchId });
  assert.equal(before.committedUsd, 10, "the video the engine has taken is committed");
  const outcome = await startBatch(db.sql, ADMIN, { batchId });
  assert.equal(outcome.stoppedAtBudget, true);
  assert.equal(outcome.started, 0, "no video was started past the budget");
  const cap = await statusOf("v_draft_cap");
  assert.equal(cap.status, "draft", "the video that would pass the budget was not started");
  assert.match(cap.lastRefusal, /past its budget of \$15\.00/);
  assert.match(cap.lastRefusal, /stopped here/);
  const after = await statusOf("v_draft_after");
  assert.equal(after.status, "draft");
  assert.match(after.lastRefusal, /stopped at an earlier video/);
  const state = outcome.batch.items.find((item) => item.sessionId === "v_draft_cap");
  assert.equal(state?.state, "blocked", "the video shows as blocked, with its reason");
});

test("a video with no budget is refused in a budgeted batch, and does not stop its siblings", async () => {
  const batch = await createBatch(db.sql, ADMIN, { brandId: BRAND, title: "Unbounded", budgetUsd: 50, sessionIds: ["v_draft_nobudget"] });
  const outcome = await startBatch(db.sql, ADMIN, { batchId: batch.id });
  assert.equal(outcome.stoppedAtBudget, false, "an unbounded video is refused without stopping the batch");
  assert.equal(outcome.refused, 1);
  assert.match((await statusOf("v_draft_nobudget")).lastRefusal, /no budget set/);
});

test("a retry is for one failed item: its siblings are not changed, and a delivered or running video cannot be retried", async () => {
  const batchId = await seedBatch("Retry", 100, ["v_failed", "v_delivered", "v_running2"]);
  const before = await getBatch(db.sql, ADMIN, { batchId });
  assert.equal(before.items.find((item) => item.sessionId === "v_failed")?.state, "retryable");
  assert.equal(before.items.find((item) => item.sessionId === "v_failed")?.attempts, 1);
  assert.match(before.items.find((item) => item.sessionId === "v_failed")?.reason ?? "", /rejected|check|intake|refused/i);
  await assert.rejects(retryBatchItem(db.sql, ADMIN, { batchId, sessionId: "v_delivered" }), /Only a failed video with attempts left/);
  await assert.rejects(retryBatchItem(db.sql, ADMIN, { batchId, sessionId: "v_running2" }), /Only a failed video with attempts left/);
  await assert.rejects(retryBatchItem(db.sql, ADMIN, { batchId, sessionId: "v_draft_a" }), /not in this batch/);

  const after = await retryBatchItem(db.sql, ADMIN, { batchId, sessionId: "v_failed" });
  const failed = await statusOf("v_failed");
  assert.equal(failed.revision, 1, "the retry is a new revision of the video");
  assert.equal(failed.status, "draft", "the new attempt waits to be started");
  assert.equal(after.items.find((item) => item.sessionId === "v_delivered")?.state, "delivered", "the delivered sibling is unchanged");
  assert.equal(after.items.find((item) => item.sessionId === "v_running2")?.state, "running", "the running sibling is unchanged");
});

test("a retry that would pass the batch budget is refused, and nothing is revised", async () => {
  // Committed: the queued video (10) and the failed one (10) make 20, so a retry of 10 under a budget of 15 would pass it.
  const batchId = await seedBatch("Tight", 15, ["v_queued", "v_failed2"]);
  const before = await statusOf("v_failed2");
  await assert.rejects(retryBatchItem(db.sql, ADMIN, { batchId, sessionId: "v_failed2" }), /past its budget/);
  assert.equal((await statusOf("v_failed2")).revision, before.revision, "a refused retry revises nothing");
});

test("a member cannot make, start or retry a batch, and the batches of a brand are read by an admin only", async () => {
  await assert.rejects(startBatch(db.sql, MEMBER, { batchId: "missing" }), /not found|admin/i);
  await assert.rejects(getBatch(db.sql, MEMBER, { batchId: "missing" }), /not found|admin/i);
});
