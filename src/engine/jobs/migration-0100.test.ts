// Migration 0100 (contract v8): engine_artifacts.type allows written_script and model_choices, and engine_role_calls.role allows
// model_chooser and scriptwriter. The checks are read from the database, and each new type is written through the artifact store, so the
// SQL check and the contract's list are tested against each other.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ARTIFACT_TYPES, CLAUDE_ROLES } from "../contracts/index.ts";
import { FIXTURE_IDS, modelChoicesEnvelopeFixture, writtenScriptEnvelopeFixture, WORKSPACE_ID } from "../contracts/fixtures/index.ts";
import { writeArtifact } from "./artifact-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";

const WS = WORKSPACE_ID;
const REQ = FIXTURE_IDS.request;

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, "brand_migration_0100");
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${REQ}, ${WS}, 'brand_migration_0100', 'fmt_fixture_rank', 'normal', 'running', '{}')
  `;
});

after(async () => {
  await db.close();
});

async function constraintOf(name: string): Promise<string> {
  const rows = await db.sql<{ def: string }>`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${name}`;
  return rows[0]?.def ?? "";
}

test("the artifact type check names every artifact type of the contracts, including written_script and model_choices", async () => {
  const definition = await constraintOf("engine_artifacts_type_check");
  assert.ok(definition.length > 0, "the type check exists");
  for (const type of ARTIFACT_TYPES) assert.ok(definition.includes(`'${type}'`), `the type check allows ${type}`);
  assert.ok(definition.includes("'written_script'") && definition.includes("'model_choices'"));
});

test("the role check names the two roles of contract v8: model_chooser and scriptwriter", async () => {
  const definition = await constraintOf("engine_role_calls_role_check");
  for (const role of CLAUDE_ROLES) assert.ok(definition.includes(`'${role}'`), `the role check allows ${role}`);
  assert.ok(definition.includes("'model_chooser'") && definition.includes("'scriptwriter'"));
});

test("a written script is stored as an artifact of its type (the table accepts the new type)", async () => {
  const body = writtenScriptEnvelopeFixture.body;
  const stored = await writeArtifact(db.sql, {
    organizationId: WS,
    requestId: REQ,
    stage: "write_script",
    type: "written_script",
    body,
    createdAt: "2026-10-17T10:00:00.000Z",
  });
  assert.equal(stored.type, "written_script");
});

test("a model choices record is stored as an artifact of its type (the table accepts the new type)", async () => {
  const body = modelChoicesEnvelopeFixture.body;
  const stored = await writeArtifact(db.sql, {
    organizationId: WS,
    requestId: REQ,
    stage: "plan",
    type: "model_choices",
    body,
    createdAt: "2026-10-17T10:00:00.000Z",
  });
  assert.equal(stored.type, "model_choices");
});

test("an unknown artifact type is still refused by the table", async () => {
  await assert.rejects(
    db.sql`
      insert into engine_artifacts (id, organization_id, request_id, type, schema, stage, parent_ids, content_hash, body)
      values ('art_migration_0100_bad', ${WS}, ${REQ}, 'robot_script', 'x', 'write_script', '[]',
        ${`sha256:${"a".repeat(64)}`}, '{}')
    `,
  );
});
