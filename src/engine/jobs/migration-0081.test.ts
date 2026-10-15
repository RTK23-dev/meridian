import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { CLAUDE_ROLES } from "../contracts/index.ts";
import { FIXTURE_IDS } from "../contracts/fixtures/index.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";

const WS = "ws_migration_0081";
const REQ = FIXTURE_IDS.request;

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, "brand_0081");
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${REQ}, ${WS}, 'brand_0081', 'fmt_0081', 'normal', 'running', '{}')
  `;
});

after(async () => {
  await db.close();
});

async function insertDecision(id: string, decidedBy: string): Promise<void> {
  await db.sql`
    insert into engine_decisions (id, organization_id, request_id, at, chose, alternatives, reason, decided_by)
    values (${id}, ${WS}, ${REQ}, 'edl_clip_1', 'caption:upper', '[]', 'the editor kept the caption band', ${decidedBy})
  `;
}

test("the editor may make a decision (engine_decisions.decided_by allows editor)", async () => {
  await insertDecision("dec_editor_1", "editor");
  const rows = await db.sql<{ n: number }>`select count(*)::int as n from engine_decisions where id = 'dec_editor_1' and decided_by = 'editor'`;
  assert.equal(rows[0]?.n, 1);
});

test("an unknown decision author is still refused", async () => {
  await assert.rejects(() => insertDecision("dec_robot_1", "robot"));
});

test("the existing decision authors are still allowed", async () => {
  for (const author of ["scorer", "director", "human"]) await insertDecision(`dec_${author}_1`, author);
  const rows = await db.sql<{ n: number }>`select count(*)::int as n from engine_decisions where request_id = ${REQ}`;
  assert.ok((rows[0]?.n ?? 0) >= 4);
});

test("the role check of engine_role_calls names every Claude role of the contracts, frame_reader included", async () => {
  const rows = await db.sql<{ def: string }>`
    select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'engine_role_calls_role_check'
  `;
  const definition = rows[0]?.def ?? "";
  assert.ok(definition.length > 0, "the role check exists");
  for (const role of CLAUDE_ROLES) {
    assert.ok(definition.includes(`'${role}'`), `the role check allows ${role}`);
  }
  assert.ok(definition.includes("'frame_reader'"));
});
