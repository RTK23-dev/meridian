// Migration 0143 (contract v13): engine_role_calls.role allows cookbook_selector, and every role of the contracts. The check is read from the
// database, so the SQL check and the contract's list are tested against each other (the same pattern as migration-0100.test.ts).

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { CLAUDE_ROLES } from "../contracts/index.ts";
import { createTestDatabase, type TestDatabase } from "../test/pg-test-db.ts";

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
});

after(async () => {
  await db.close();
});

test("the role check names every role of the contracts, and cookbook_selector is one of them (contract v13)", async () => {
  const rows = await db.sql<{ def: string }>`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'engine_role_calls_role_check'`;
  const definition = rows[0]?.def ?? "";
  assert.ok(definition.length > 0, "the role check exists");
  for (const role of CLAUDE_ROLES) assert.ok(definition.includes(`'${role}'`), `the role check allows ${role}`);
  assert.ok(definition.includes("'cookbook_selector'"));
});
