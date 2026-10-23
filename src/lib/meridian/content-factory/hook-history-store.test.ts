// The hook history of a brand, read from a real database (PGlite with every migration). A started video counts with the hook of its own
// script; a draft, another brand, and another workspace never count; a person outside the workspace's admins is refused; and a run whose
// script has no hook is counted as started with no hook, not as a repeat.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { brandHookHistory } from "./service.ts";

const WS = "org_hooks";
const OTHER_WS = "org_hooks_other";
const BRAND = "brand_hooks";
const OTHER_BRAND = "brand_hooks_second";
const ADMIN = "user_hooks_admin";
const VIEWER = "user_hooks_viewer";
const STRANGER = "user_hooks_stranger";
const SHA = `sha256:${"0".repeat(64)}`;

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  await seedWorkspace(db.sql, OTHER_WS, "brand_hooks_other_ws");
  for (const [id, role] of [[ADMIN, "admin"], [VIEWER, "viewer"]] as const) {
    await db.sql`insert into "user" (id, name, email, "emailVerified") values (${id}, ${id}, ${`${id}@fixture.example`}, true)`;
    await db.sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${id}`}, ${WS}, ${id}, ${role})`;
  }
  await db.sql`insert into "user" (id, name, email, "emailVerified") values (${STRANGER}, ${STRANGER}, ${`${STRANGER}@fixture.example`}, true)`;
  await db.sql`insert into brands (id, organization_id, name, sells, created_by) values (${OTHER_BRAND}, ${WS}, 'Second brand', 'Other', ${ADMIN})`;

  await startedSession("sess_written_a", "Lather A", BRAND, "2026-10-01T10:00:00Z", { written: [{ role: "hook", text: "Stop scrolling!" }, { role: "payoff", text: "Done" }] });
  await startedSession("sess_user_b", "Lather B", BRAND, "2026-10-02T10:00:00Z", { requested: [{ role: "hook", text: "stop scrolling" }] });
  await startedSession("sess_no_hook_c", "Lather C", BRAND, "2026-10-03T10:00:00Z", { written: [{ role: "setup", text: "A sink" }] });
  await startedSession("sess_unwritten_d", "Lather D", BRAND, "2026-10-04T10:00:00Z", {});
  await startedSession("sess_other_brand_e", "Other brand", OTHER_BRAND, "2026-10-05T10:00:00Z", { written: [{ role: "hook", text: "Stop scrolling!" }] });
  await startedSession("sess_other_ws_f", "Other workspace", "brand_hooks_other_ws", "2026-10-06T10:00:00Z", { written: [{ role: "hook", text: "Stop scrolling!" }] }, OTHER_WS);
  await db.sql`
    insert into content_factory_sessions (id, organization_id, brand_id, created_by, title, status)
    values ('sess_draft_g', ${WS}, ${BRAND}, ${ADMIN}, 'Draft', 'draft')
  `;
});

after(async () => {
  await db.close();
});

type Script = { written?: { role: string; text: string }[]; requested?: { role: string; text: string }[] };

/** A started session with its engine request, and the artifacts the run stored: a written script, or the person's own script. */
async function startedSession(id: string, title: string, brandId: string, startedAt: string, script: Script, organizationId = WS): Promise<void> {
  const requestId = `req_${id}`;
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${requestId}, ${organizationId}, ${brandId}, 'fmt_hooks', 'normal', 'running', '{}')
  `;
  if (script.written) {
    await artifact(requestId, organizationId, "written_script", "write_script", { schema: "meridian.written_script/v1", requestId, language: "en", beats: script.written, rationale: "x" });
  }
  if (script.requested) {
    await artifact(requestId, organizationId, "production_request", "intake", { requestId, script: { language: "en", beats: script.requested } });
  }
  await db.sql`
    insert into content_factory_sessions (id, organization_id, brand_id, created_by, title, status, engine_request_id, started_at)
    values (${id}, ${organizationId}, ${brandId}, ${ADMIN}, ${title}, 'started', ${requestId}, ${startedAt})
  `;
}

async function artifact(requestId: string, organizationId: string, type: string, stage: string, body: unknown): Promise<void> {
  await db.sql`
    insert into engine_artifacts (id, organization_id, request_id, type, schema, stage, parent_ids, content_hash, body)
    values (${`art_${requestId}_${type}`}, ${organizationId}, ${requestId}, ${type}, ${`meridian.${type}/v1`}, ${stage}, '[]', ${SHA}, ${JSON.stringify(body)})
  `;
}

test("a brand's started videos are read with the hook of their own script, and the same hook is a repeat", async () => {
  const history = await brandHookHistory(db.sql, ADMIN, { organizationId: WS, brandId: BRAND });
  assert.equal(history.started, 4, "the started videos of this brand: A, B, C and D (the draft and the other brand and workspace are not counted)");
  assert.equal(history.hooked, 2, "A (written) and B (the person's script) have a hook; C has no hook beat; D has no script yet");
  assert.equal(history.repeats.length, 1);
  assert.equal(history.repeats[0]?.kind, "same");
  assert.deepEqual(history.repeats[0]?.records.map((record) => record.sessionId), ["sess_user_b", "sess_written_a"], "newest first");
});

test("a person who is not an admin of the workspace is refused, and so is a brand from another workspace", async () => {
  await assert.rejects(brandHookHistory(db.sql, VIEWER, { organizationId: WS, brandId: BRAND }), /admin/i);
  await assert.rejects(brandHookHistory(db.sql, STRANGER, { organizationId: WS, brandId: BRAND }), /not available to you/);
  await assert.rejects(brandHookHistory(db.sql, ADMIN, { organizationId: WS, brandId: "brand_hooks_other_ws" }), /not in this workspace/);
});

test("a brand with no started video reads as empty, not as a repeat", async () => {
  const history = await brandHookHistory(db.sql, ADMIN, { organizationId: WS, brandId: OTHER_BRAND });
  assert.deepEqual(history, { started: 1, hooked: 1, repeats: [] }, "the other brand has one started video and no repeat");
});
