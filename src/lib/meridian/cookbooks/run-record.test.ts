// The cookbook record of a run (K13) on PGlite: recorded on a draft, fixed once the run has started, and read back as it was written.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { cookbookSelectionOf, recordCookbookSelection } from "./run-record.ts";
import type { SelectionRecord } from "./select.ts";

const ORG = "org_run_record";
const BRAND = "brand_run_record";
let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, ORG, BRAND);
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values ('req_run_record', ${ORG}, ${BRAND}, 'ref_run_record', 'normal', 'running', '{}')
  `;
  await db.sql`
    insert into content_factory_sessions (id, organization_id, brand_id, title, status)
    values ('cfs_draft', ${ORG}, ${BRAND}, 'Draft run', 'draft')
  `;
  await db.sql`
    insert into content_factory_sessions (id, organization_id, brand_id, title, status, engine_request_id, started_at)
    values ('cfs_started', ${ORG}, ${BRAND}, 'Started run', 'started', 'req_run_record', now())
  `;
});

after(async () => {
  await db.close();
});

const RECORD: SelectionRecord = {
  cookbookId: "ck_3d_data_explainer",
  version: 2,
  values: { pace: 0.8 },
  valuesHash: "sha256:abc",
  how: "changed",
  proposedCookbookId: "ck_3d_data_explainer",
};

test("a draft run records its choice, and the record reads back as written", async () => {
  const written = await recordCookbookSelection(db.sql, { organizationId: ORG, sessionId: "cfs_draft", record: RECORD });
  assert.equal(written, true);
  const read = await cookbookSelectionOf(db.sql, { organizationId: ORG, sessionId: "cfs_draft" });
  assert.equal(read?.cookbookId, "ck_3d_data_explainer");
  assert.equal(read?.how, "changed");
  assert.deepEqual(read?.values, { pace: 0.8 });
  assert.ok(read?.recordedAt);
});

test("a run that has started keeps its record: nothing is written over it", async () => {
  const written = await recordCookbookSelection(db.sql, { organizationId: ORG, sessionId: "cfs_started", record: RECORD });
  assert.equal(written, false);
  assert.equal(await cookbookSelectionOf(db.sql, { organizationId: ORG, sessionId: "cfs_started" }), null);
});

test("a run in another workspace is not written, and reads nothing", async () => {
  const written = await recordCookbookSelection(db.sql, { organizationId: "org_other", sessionId: "cfs_draft", record: RECORD });
  assert.equal(written, false);
  assert.equal(await cookbookSelectionOf(db.sql, { organizationId: "org_other", sessionId: "cfs_draft" }), null);
});
