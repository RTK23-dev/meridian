// The audit log's filters against a real database. The default form sends empty dates; Postgres refuses to cast an empty string to a date,
// so the audit screen failed on every default load. An empty date is an open end of the range, and a date keeps the rows of that day.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { countAuditRows, selectAuditRows, type AuditFilters } from "./audit-query.ts";

const WS = "org_audit_query";
let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, "brand_audit_query");
  await db.sql`
    insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata, created_at) values
      ('audit_older', ${WS}, null, 'user_a', 'job.retried', 'job', 'job_1', '{}', '2026-10-01T10:00:00Z'),
      ('audit_newer', ${WS}, null, 'user_a', 'job.retried', 'job', 'job_2', '{}', '2026-10-02T12:00:00Z')
  `;
});

after(async () => {
  await db.close();
});

function filters(overrides: Partial<AuditFilters> = {}): AuditFilters {
  return { organizationId: WS, actor: "", action: "", brandId: "", from: "", to: "", page: 0, ...overrides };
}

async function idsOf(f: AuditFilters): Promise<string[]> {
  const rows = await selectAuditRows(db.sql, f, 50, 0);
  return rows.map((row) => String(row.id ?? "")).sort();
}

test("the default filter (empty dates) lists every row and counts them, and does not fail", async () => {
  assert.deepEqual(await idsOf(filters()), ["audit_newer", "audit_older"]);
  assert.equal(await countAuditRows(db.sql, filters()), 2);
});

test("a date keeps the rows of that day, and a range ends on its last day", async () => {
  assert.deepEqual(await idsOf(filters({ from: "2026-10-02", to: "2026-10-02" })), ["audit_newer"]);
  assert.equal(await countAuditRows(db.sql, filters({ from: "2026-10-01", to: "2026-10-01" })), 1);
  assert.deepEqual(await idsOf(filters({ from: "2026-10-01" })), ["audit_newer", "audit_older"], "an open start keeps every later row");
});

test("a from date after every row returns none, and a to date before every row returns none", async () => {
  assert.equal(await countAuditRows(db.sql, filters({ from: "2026-11-01" })), 0);
  assert.deepEqual(await idsOf(filters({ to: "2026-09-30" })), []);
});
