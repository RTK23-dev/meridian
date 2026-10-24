// The download link of a delivered video. A link is never made for a video the engine has not delivered: a draft has no video, a started
// run that is not delivered has no master, and a viewer of the workspace cannot ask. (The signed-link path itself needs a delivered engine
// request with a manifest and a rendered video; that fixture is not built here, so it is not claimed as tested.)

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { deliveredMasterLink } from "./service.ts";

const WS = "org_delivered_link";
const BRAND = "brand_delivered_link";
const ADMIN = "user_delivered_admin";
const VIEWER = "user_delivered_viewer";
const SIGNER = {
  sign: async () => ({ status: "ok" as const, url: "https://example.invalid/never-used", expires: 0 }),
};

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  for (const [id, role] of [[ADMIN, "admin"], [VIEWER, "viewer"]] as const) {
    await db.sql`insert into "user" (id, name, email, "emailVerified") values (${id}, ${id}, ${`${id}@fixture.example`}, true)`;
    await db.sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${id}`}, ${WS}, ${id}, ${role})`;
  }
  await db.sql`
    insert into content_factory_sessions (id, organization_id, brand_id, created_by, title, status)
    values ('sess_link_draft', ${WS}, ${BRAND}, ${ADMIN}, 'Draft reel', 'draft')
  `;
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values ('req_link_running', ${WS}, ${BRAND}, 'fmt_link', 'normal', 'running', '{}')
  `;
  await db.sql`
    insert into content_factory_sessions (id, organization_id, brand_id, created_by, title, status, engine_request_id, started_at)
    values ('sess_link_running', ${WS}, ${BRAND}, ${ADMIN}, 'Running reel', 'started', 'req_link_running', now())
  `;
});

after(async () => {
  await db.close();
});

test("a draft session has no video, so no link is made", async () => {
  const link = await deliveredMasterLink(db.sql, ADMIN, { sessionId: "sess_link_draft" }, SIGNER);
  assert.equal(link.status, "not_ready");
  assert.match(link.status === "not_ready" ? link.reason : "", /no video yet/);
});

test("a started run that the engine has not delivered has no master, and no link is made", async () => {
  const link = await deliveredMasterLink(db.sql, ADMIN, { sessionId: "sess_link_running" }, SIGNER);
  assert.notEqual(link.status, "ready", "an undelivered run never gets a download link");
  assert.equal(link.status, "not_ready");
});

test("a viewer of the workspace is refused: the link is an admin's action", async () => {
  await assert.rejects(deliveredMasterLink(db.sql, VIEWER, { sessionId: "sess_link_running" }, SIGNER), /admin/i);
});
