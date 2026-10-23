// A decision on an engine review item (Bible 12.5), against a real PGlite database: a sampled video's decision moves its format's count and
// resolves the item once; a retried delivery queues no duplicate; a take escalation's reject resolves it with no orchestrator event; and an
// accept that the orchestrator refuses leaves the item open.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { takeVerdictSchema, type TakeVerdict } from "../contracts/take.ts";
import { takeReviewItem } from "../review/inbox.ts";
import { REQUEST_ID, SHOT_ID, TAKE_ID } from "../review/test/helpers.ts";
import { WORKSPACE_ID } from "../contracts/fixtures/chain.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { decideEngineReviewItem } from "./review-decision.ts";
import { sampleDelivery } from "./sampling.ts";
import { sqlSamplingPorts } from "./sampling-store.ts";

const WS = WORKSPACE_ID;
const FORMAT = "fmt_review_decision";
const NOW = "2026-10-20T10:00:00.000Z";
const VIDEO_A = "vid_01HZAAAAAAAAAAAAAAAAAAAAAA";
const VIDEO_B = "vid_01HZBBBBBBBBBBBBBBBBBBBBBB";

const verdict: TakeVerdict = takeVerdictSchema.parse({
  takeId: TAKE_ID,
  pass: false,
  confidence: 0.4,
  checks: [{ rule: "product_match", pass: false, score: 0.4, detail: "the product is not clear" }],
  action: "escalate",
});

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, "brand_fixture");
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${REQUEST_ID}, ${WS}, 'brand_fixture', ${FORMAT}, 'normal', 'running', '{}')
  `;
});

after(async () => {
  await db.close();
});

async function sampleItems(): Promise<{ id: string; status: string; detail: string }[]> {
  return db.sql<{ id: string; status: string; detail: string }>`
    select id, status, detail from engine_review_items
    where organization_id = ${WS} and kind = 'sample' and request_id = ${REQUEST_ID}
    order by id
  `;
}

async function reviewDecidedCount(itemId: string): Promise<number> {
  const rows = await db.sql<{ n: number }>`
    select count(*)::int as n from engine_events
    where organization_id = ${WS} and kind = 'review.decided' and subject_id = ${itemId}
  `;
  return Number(rows[0]?.n ?? 0);
}

test("a sampled video is queued once, and each decision on it moves the format's count and resolves it once", async () => {
  const ports = sqlSamplingPorts(db.sql);
  const delivered = await sampleDelivery(ports, {
    organizationId: WS,
    requestId: REQUEST_ID,
    formatKey: FORMAT,
    videoIds: [VIDEO_A, VIDEO_B],
    thresholdVersion: "thr_v1",
    now: NOW,
  });
  assert.equal(delivered.rate, 1, "a new format samples every video");
  assert.deepEqual(delivered.sampled, [VIDEO_A, VIDEO_B]);
  const stored = await ports.state({ organizationId: WS, formatKey: FORMAT });
  assert.equal(stored.thresholdVersion, "thr_v1", "the threshold version is recorded at the first delivery");

  const items = await sampleItems();
  assert.equal(items.length, 2, "each sampled video is one review item");
  assert.ok(items.every((item) => item.status === "open"));

  const first = items[0]!;
  const accepted = await decideEngineReviewItem(db.sql, {
    organizationId: WS,
    itemId: first.id,
    actorId: "user_reviewer",
    decision: { action: "accept", reason: "the video is clear and on brief" },
    now: NOW,
  });
  assert.equal(accepted.effect, "sampling");
  assert.equal(accepted.labels, 0, "a sampled video's checks are not labelled");
  assert.equal((await ports.state({ organizationId: WS, formatKey: FORMAT })).consecutivePasses, 1, "an accept is one pass");
  assert.equal(await reviewDecidedCount(first.id), 1, "the decision is recorded once");

  await assert.rejects(
    decideEngineReviewItem(db.sql, {
      organizationId: WS,
      itemId: first.id,
      actorId: "user_reviewer",
      decision: { action: "accept", reason: "a second click" },
      now: NOW,
    }),
    /already resolved/,
    "a resolved item cannot be decided again",
  );
  assert.equal((await ports.state({ organizationId: WS, formatKey: FORMAT })).consecutivePasses, 1, "the refused repeat moves nothing");

  const second = items[1]!;
  await decideEngineReviewItem(db.sql, {
    organizationId: WS,
    itemId: second.id,
    actorId: "user_reviewer",
    decision: { action: "reject", reason: "the claim is not supported" },
    now: NOW,
  });
  assert.equal((await ports.state({ organizationId: WS, formatKey: FORMAT })).consecutivePasses, 0, "a reject starts the count again");
});

test("a retried delivery queues no duplicate review item, and samples the same videos", async () => {
  const ports = sqlSamplingPorts(db.sql);
  const before = (await sampleItems()).length;
  const retried = await sampleDelivery(ports, {
    organizationId: WS,
    requestId: REQUEST_ID,
    formatKey: FORMAT,
    videoIds: [VIDEO_A, VIDEO_B],
    thresholdVersion: "thr_v1",
    now: NOW,
  });
  assert.deepEqual(retried.sampled, [VIDEO_A, VIDEO_B], "the same videos are drawn again");
  assert.equal((await sampleItems()).length, before, "the review items are keyed, so the retry writes none");
});

test("a take escalation rejected records its decision with no orchestrator event, and resolves the item", async () => {
  const item = takeReviewItem({
    requestId: REQUEST_ID,
    shotId: SHOT_ID,
    visualType: "product_hero",
    reason: "the shot has no passing take, and the take needs a human",
    planArtifactId: null,
    takes: [{ takeId: TAKE_ID, takeArtifactId: null, verdictArtifactId: null, verdict }],
  });
  await db.sql`
    insert into engine_review_items (id, organization_id, request_id, kind, status, subject_id, reason, detail)
    values ('revtake_reject', ${WS}, ${REQUEST_ID}, 'escalation', 'open', ${SHOT_ID}, ${item.reason}, ${JSON.stringify(item)})
  `;
  const result = await decideEngineReviewItem(db.sql, {
    organizationId: WS,
    itemId: "revtake_reject",
    actorId: "user_reviewer",
    decision: { action: "reject", reason: "the take is not the product" },
    now: NOW,
  });
  assert.equal(result.effect, null, "a reject does not move the orchestrator here");
  const rows = await db.sql<{ status: string }>`select status from engine_review_items where id = 'revtake_reject'`;
  assert.equal(rows[0]?.status, "resolved");
  const choices = await db.sql<{ n: number }>`
    select count(*)::int as n from engine_events where organization_id = ${WS} and kind = 'human_choice'
  `;
  assert.equal(Number(choices[0]?.n ?? 0), 0, "no human choice was applied");
});

test("an accept the orchestrator refuses leaves the take item open", async () => {
  const item = takeReviewItem({
    requestId: REQUEST_ID,
    shotId: SHOT_ID,
    visualType: "product_hero",
    reason: "the shot has no passing take, and the take needs a human",
    planArtifactId: null,
    takes: [{ takeId: TAKE_ID, takeArtifactId: null, verdictArtifactId: null, verdict }],
  });
  await db.sql`
    insert into engine_review_items (id, organization_id, request_id, kind, status, subject_id, reason, detail)
    values ('revtake_refused', ${WS}, ${REQUEST_ID}, 'escalation', 'open', ${SHOT_ID}, ${item.reason}, ${JSON.stringify(item)})
  `;
  await assert.rejects(
    decideEngineReviewItem(db.sql, {
      organizationId: WS,
      itemId: "revtake_refused",
      actorId: "user_reviewer",
      decision: { action: "accept", takeId: TAKE_ID, reason: "this take is the one" },
      now: NOW,
    }),
  );
  const rows = await db.sql<{ status: string }>`select status from engine_review_items where id = 'revtake_refused'`;
  assert.equal(rows[0]?.status, "open", "a refused choice leaves the item open for another decision");
});
