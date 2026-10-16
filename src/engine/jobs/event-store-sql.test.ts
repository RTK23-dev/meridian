import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { FIXTURE_IDS } from "../contracts/fixtures/index.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import type { EventRecord } from "../events/store.ts";
import { sqlEventStore } from "./event-store-sql.ts";

const WS = "ws_events";
const OTHER = "ws_events_other";
const REQ = FIXTURE_IDS.request;
const AT = "2026-10-15T11:00:00.000Z";

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, "brand_events");
  await seedWorkspace(db.sql, OTHER, "brand_other");
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${REQ}, ${WS}, 'brand_events', 'fmt_events', 'normal', 'running', '{}')
  `;
});

after(async () => {
  await db.close();
});

function record(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    organizationId: WS,
    requestId: REQ,
    kind: "gate.result",
    stage: "pre_render_gate",
    subjectId: FIXTURE_IDS.edl,
    jobId: "job_1",
    dedupeKey: null,
    body: { gate: "pre_render", pass: false },
    at: AT,
    ...overrides,
  };
}

test("an event is appended once per dedupe key, and a repeat changes nothing", async () => {
  const store = sqlEventStore(db.sql);
  const first = await store.append(record({ dedupeKey: "gate:pre:edl-1" }));
  const again = await store.append(record({ dedupeKey: "gate:pre:edl-1", body: { gate: "pre_render", pass: true } }));
  assert.equal(first.created, true);
  assert.equal(again.created, false, "the same dedupe key is stored once");
  const listed = await store.list({ organizationId: WS, requestId: REQ });
  const keyed = listed.filter((row) => row.dedupeKey === "gate:pre:edl-1");
  assert.equal(keyed.length, 1);
  assert.deepEqual(keyed[0]?.body, { gate: "pre_render", pass: false }, "the first body is kept");
});

test("events without a dedupe key are all stored, in order", async () => {
  const store = sqlEventStore(db.sql);
  await store.append(record({ kind: "video.delivered", stage: "deliver", body: { videoId: "vid_a" }, at: "2026-10-15T11:00:01.000Z" }));
  await store.append(record({ kind: "video.delivered", stage: "deliver", body: { videoId: "vid_b" }, at: "2026-10-15T11:00:02.000Z" }));
  const delivered = (await store.list({ organizationId: WS, requestId: REQ })).filter((row) => row.kind === "video.delivered");
  assert.deepEqual(
    delivered.map((row) => (row.body as { videoId: string }).videoId),
    ["vid_a", "vid_b"],
  );
});

test("the list is scoped to the workspace: another workspace reads nothing of the request", async () => {
  const store = sqlEventStore(db.sql);
  assert.ok((await store.list({ organizationId: WS, requestId: REQ })).length > 0);
  assert.deepEqual(await store.list({ organizationId: OTHER, requestId: REQ }), []);
});

test("an append for a request of another workspace is refused by the foreign key", async () => {
  const store = sqlEventStore(db.sql);
  await assert.rejects(() => store.append(record({ organizationId: OTHER, dedupeKey: "cross-tenant" })));
});

test("the log rows the orchestrator writes (not learning kinds) are not returned as events", async () => {
  await db.sql`
    insert into engine_events (id, organization_id, request_id, kind, stage, subject_id, job_id, dedupe_key, body)
    values ('evt_internal_1', ${WS}, ${REQ}, 'stage.succeeded', 'plan', ${REQ}, '', null, '{}')
  `;
  const listed = await sqlEventStore(db.sql).list({ organizationId: WS, requestId: REQ });
  const kinds: string[] = listed.map((row) => row.kind);
  assert.ok(!kinds.includes("stage.succeeded"));
});
