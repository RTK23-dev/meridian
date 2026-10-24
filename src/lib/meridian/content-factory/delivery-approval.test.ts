// The approval of a delivered video (prompt 16), on PGlite with every migration. A decision is made on the video the engine delivered, once,
// with a reason for a rejection, and is audited. A revision is a new request: it starts undecided, and the earlier decisions stay in the
// history. Publishing is reported as not connected, and nothing is shown as published.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { approvalProblem, approvalStateFor, publishStateOf, type ApprovalRecord } from "./approval.ts";
import { deliveryApprovalOf, recordDeliveryApproval } from "./service.ts";

const WS = "org_delivery_approval";
const BRAND = "brand_delivery_approval";
const ADMIN = "user_approval_admin";
const MEMBER = "user_approval_member";
const VIEWER = "user_approval_viewer";
const SESSION = "sess_appr";
const UNDELIVERED = "sess_appr_running";

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  for (const [id, role] of [[ADMIN, "admin"], [MEMBER, "member"], [VIEWER, "viewer"]] as const) {
    await db.sql`insert into "user" (id, name, email, "emailVerified") values (${id}, ${id}, ${`${id}@fixture.example`}, true)`;
    await db.sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${id}`}, ${WS}, ${id}, ${role})`;
  }
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values ('req_appr_1', ${WS}, ${BRAND}, 'fmt_appr', 'normal', 'delivered', '{}'),
           ('req_appr_running', ${WS}, ${BRAND}, 'fmt_appr', 'normal', 'running', '{}')
  `;
  await db.sql`
    insert into content_factory_sessions (id, organization_id, brand_id, created_by, title, status, engine_request_id, started_at)
    values (${SESSION}, ${WS}, ${BRAND}, ${ADMIN}, 'Delivered reel', 'started', 'req_appr_1', now()),
           (${UNDELIVERED}, ${WS}, ${BRAND}, ${ADMIN}, 'Running reel', 'started', 'req_appr_running', now())
  `;
});

after(async () => {
  await db.close();
});

test("the rules are pure: a rejection needs its reason, the latest decision is the state, and publishing is not connected", () => {
  assert.equal(approvalProblem({ decision: "approved", reason: "" }), null, "an approval may carry no note");
  assert.match(approvalProblem({ decision: "rejected", reason: "no" }) ?? "", /at least 10/);
  assert.equal(approvalProblem({ decision: "rejected", reason: "The lather shot is out of focus." }), null);
  assert.match(approvalProblem({ decision: "maybe", reason: "" }) ?? "", /Choose approve or reject/);

  const records: ApprovalRecord[] = [
    { engineRequestId: "req_a", decision: "approved", reason: "", actorId: "u1", createdAt: "2026-10-01T00:00:00.000Z" },
    { engineRequestId: "req_a", decision: "rejected", reason: "Too slow to start.", actorId: "u2", createdAt: "2026-10-02T00:00:00.000Z" },
    { engineRequestId: "req_b", decision: "approved", reason: "", actorId: "u1", createdAt: "2026-10-03T00:00:00.000Z" },
  ];
  assert.equal(approvalStateFor(records, "req_a").status, "rejected", "the later decision on the same video is the state");
  assert.equal(approvalStateFor(records, "req_b").status, "approved");
  assert.equal(approvalStateFor(records, "req_c").status, "not_decided", "a video with no decision is not decided");
  assert.equal(publishStateOf().status, "not_connected");
});

test("nothing is decided yet, the video is shown as delivered, and publishing is not connected", async () => {
  const state = await deliveryApprovalOf(db.sql, ADMIN, { sessionId: SESSION });
  assert.equal(state.requestId, "req_appr_1");
  assert.equal(state.delivered, true);
  assert.deepEqual(state.state, { status: "not_decided" });
  assert.deepEqual(state.history, []);
  assert.equal(state.publish.status, "not_connected");
});

test("a member and a viewer are refused, and nothing is recorded", async () => {
  await assert.rejects(recordDeliveryApproval(db.sql, MEMBER, { sessionId: SESSION, decision: "approved", reason: "" }), /admin/i);
  await assert.rejects(recordDeliveryApproval(db.sql, VIEWER, { sessionId: SESSION, decision: "approved", reason: "" }), /admin/i);
  await assert.rejects(deliveryApprovalOf(db.sql, VIEWER, { sessionId: SESSION }), /admin/i);
  const [count] = await db.sql<{ count: string }>`select count(*)::text as count from content_factory_approvals where session_id = ${SESSION}`;
  assert.equal(count?.count, "0");
});

test("a video the engine has not delivered cannot be approved", async () => {
  await assert.rejects(recordDeliveryApproval(db.sql, ADMIN, { sessionId: UNDELIVERED, decision: "approved", reason: "" }), /not delivered/);
});

test("a rejection without its reason is refused, and writes nothing", async () => {
  await assert.rejects(recordDeliveryApproval(db.sql, ADMIN, { sessionId: SESSION, decision: "rejected", reason: "no" }), /at least 10/);
  const state = await deliveryApprovalOf(db.sql, ADMIN, { sessionId: SESSION });
  assert.equal(state.history.length, 0);
});

test("an approval is recorded once, audited, and a repeat is refused", async () => {
  const state = await recordDeliveryApproval(db.sql, ADMIN, { sessionId: SESSION, decision: "approved", reason: "" });
  assert.equal(state.state.status, "approved");
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0]?.engineRequestId, "req_appr_1", "the decision names the video it was made on");
  await assert.rejects(recordDeliveryApproval(db.sql, ADMIN, { sessionId: SESSION, decision: "approved", reason: "" }), /already approved/);
  const audits = await db.sql<{ action: string }>`select action from audit_log where object_id = ${SESSION} and action = 'content_factory.video_approved'`;
  assert.equal(audits.length, 1, "one audit line for the one approval");
});

test("a rejection after an approval becomes the state, and both decisions stay in the history", async () => {
  const state = await recordDeliveryApproval(db.sql, ADMIN, { sessionId: SESSION, decision: "rejected", reason: "The lather shot is out of focus." });
  assert.equal(state.state.status, "rejected");
  assert.equal(state.history.map((item) => item.decision).join(","), "approved,rejected");
});

test("a revision is a new request: it starts undecided, the earlier decisions stay, and it can be decided once delivered", async () => {
  await db.sql`insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state) values ('req_appr_2', ${WS}, ${BRAND}, 'fmt_appr', 'normal', 'running', '{}')`;
  await db.sql`update content_factory_sessions set engine_request_id = 'req_appr_2' where id = ${SESSION}`;
  const revising = await deliveryApprovalOf(db.sql, ADMIN, { sessionId: SESSION });
  assert.equal(revising.requestId, "req_appr_2");
  assert.equal(revising.delivered, false);
  assert.deepEqual(revising.state, { status: "not_decided" }, "the revision starts with no decision");
  assert.equal(revising.history.length, 2, "the decisions on the earlier video stay in the history");
  await assert.rejects(recordDeliveryApproval(db.sql, ADMIN, { sessionId: SESSION, decision: "approved", reason: "" }), /not delivered/);

  await db.sql`update engine_requests set status = 'delivered' where id = 'req_appr_2'`;
  const decided = await recordDeliveryApproval(db.sql, ADMIN, { sessionId: SESSION, decision: "approved", reason: "" });
  assert.equal(decided.state.status, "approved");
  assert.equal(decided.history.length, 3);
  assert.equal(decided.history[1]?.engineRequestId, "req_appr_1", "the earlier rejection still names the earlier video");
  assert.equal(decided.history[2]?.engineRequestId, "req_appr_2");
});
