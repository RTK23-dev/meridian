import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestDatabase, migrationFiles, type TestDatabase } from "../test/pg-test-db.ts";

/** The engine tables of Bible 5.4 as this workstream names them (engine_jobs is the existing jobs table, so it is absent). */
const ENGINE_TABLES = [
  "engine_requests",
  "engine_artifacts",
  "engine_gate_results",
  "engine_decisions",
  "engine_ledger",
  "engine_reservations",
  "engine_manifests",
  "engine_review_items",
  "engine_kits",
  "engine_cache_index",
  "engine_events",
  "engine_role_calls",
  "engine_provider_attempts",
  "engine_provider_breakers",
  "engine_buckets",
  "engine_bucket_leases",
  "engine_asset_cache",
  "engine_asset_cache_hits",
  // Chain call records (migrations/0094): the spec and the output of each call of a chain (contract v5, Bible 7.1).
  "engine_chain_calls",
  // Call telemetry and bill reads (migrations/0112): what each paid call measured, and how held calls' bills are read.
  "engine_call_telemetry",
  "engine_bill_reads",
] as const;

const MIGRATION = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "migrations", "0077_engine_core.sql");

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
});

after(async () => {
  await db.close();
});

test("the engine migrations follow the migrations they build on, and every migration number is used once", () => {
  const files = migrationFiles();
  const index = files.indexOf("0077_engine_core.sql");
  assert.ok(index > 0, "0077_engine_core.sql exists");
  assert.equal(files[index - 1], "0076_factory_video_carousel.sql");
  assert.ok(files.indexOf("0078_engine_role_calls.sql") > index, "the role-call table comes after the engine core");
  assert.ok(files.indexOf("0080_engine_asset_stores.sql") > files.indexOf("0078_engine_role_calls.sql"), "the asset stores come after the role calls");
  // From the engine migrations on (an older duplicate, 0027, predates the engine and is left as it is).
  const numbers = files.map((file) => file.slice(0, 4)).filter((prefix) => /^\d{4}$/.test(prefix) && Number(prefix) >= 77);
  assert.equal(new Set(numbers).size, numbers.length, "no migration number from 0077 on is used twice");
});

test("every Bible 5.4 engine table exists and carries the tenant column organization_id, not null", async () => {
  const rows = await db.sql<{ table_name: string; is_nullable: string }>`
    select table_name, is_nullable from information_schema.columns
    where table_schema = 'public' and column_name = 'organization_id' and table_name like 'engine_%'
  `;
  const byTable = new Map(rows.map((row) => [row.table_name, row.is_nullable]));
  for (const table of ENGINE_TABLES) {
    assert.ok(byTable.has(table), `${table} has an organization_id column`);
    assert.equal(byTable.get(table), "NO", `${table}.organization_id is not null`);
  }
  const extra = [...byTable.keys()].filter((name) => !(ENGINE_TABLES as readonly string[]).includes(name));
  assert.deepEqual(extra, [], "no engine table is missing from the list");
});

test("every engine table is linked to its workspace by a foreign key on organization_id", async () => {
  const rows = await db.sql<{ table_name: string }>`
    select distinct kcu.table_name from information_schema.key_column_usage kcu
    join information_schema.table_constraints tc on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
    where tc.constraint_type = 'FOREIGN KEY' and kcu.column_name = 'organization_id' and kcu.table_name like 'engine_%'
  `;
  const linked = new Set(rows.map((row) => row.table_name));
  for (const table of ENGINE_TABLES) {
    assert.ok(linked.has(table), `${table} references its workspace`);
  }
});

test("an idempotency key is unique per workspace on engine_ledger, as the budget requires", async () => {
  const rows = await db.sql<{ indexdef: string }>`
    select indexdef from pg_indexes where tablename = 'engine_ledger' and indexdef like '%UNIQUE%'
  `;
  assert.ok(
    rows.some((row) => /\(organization_id, idempotency_key\)/.test(row.indexdef)),
    "a unique index on (organization_id, idempotency_key) exists",
  );
});

test("the artifact table refuses updates by trigger, and the migration file carries no S3 reference", async () => {
  const triggers = await db.sql<{ tgname: string }>`
    select tgname from pg_trigger where tgrelid = 'engine_artifacts'::regclass and not tgisinternal
  `;
  assert.ok(triggers.some((row) => row.tgname === "engine_artifacts_immutable"));
  const text = readFileSync(MIGRATION, "utf8");
  assert.doesNotMatch(text, /\bs3_|s3:\/\/|s3_uri/i, "no S3 column or URI is created (NORTH_STAR decision 2: S3 is retired)");
});

test("the migration applies again without error, so a repeated deploy is safe", async () => {
  await db.exec(readFileSync(MIGRATION, "utf8"));
  const rows = await db.sql<{ n: number }>`select count(*)::int as n from information_schema.tables where table_name like 'engine_%'`;
  assert.equal(rows[0]?.n, ENGINE_TABLES.length);
});

test("the request priority and artifact type are closed sets, enforced by check constraints", async () => {
  await db.sql`insert into organizations (id, name, slug, created_by) values ('ws_closed', 'ws_closed', 'ws-closed', 'test') on conflict (id) do nothing`;
  await assert.rejects(
    db.sql`
      insert into engine_requests (id, organization_id, format_id, priority, status, state)
      values ('req_01J9ZK3M4N5P6Q7R8S9T0V1W2X', 'ws_closed', 'f', 'urgent', 'running', '{}')
    `,
    /violates check constraint/,
  );
  await assert.rejects(
    db.sql`
      insert into engine_artifacts (id, organization_id, request_id, type, schema, stage, content_hash, body)
      values ('art_01J9ZK3M4N5P6Q7R8S9T0V1W2X', 'ws_closed', 'req_01J9ZK3M4N5P6Q7R8S9T0V1W2X', 'mystery', 's', 'x', ${`sha256:${"a".repeat(64)}`}, '{}')
    `,
    /violates check constraint/,
  );
});
