// The cookbook results export on PGlite (K28, Q41): with no measure recorded the export says so; with a measure it counts the measured run.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { cookbookResultsExport } from "./export.ts";
import { recordCookbookSelection } from "./run-record.ts";
import type { SelectionRecord } from "./select.ts";

const ORG = "org_cookbook_export";
const BRAND = "brand_cookbook_export";
const REQUEST = "req_01JABCDEFGHJKMNPQRSTVWXYZ1";
let db: TestDatabase;

const RECORD: SelectionRecord = {
  cookbookId: "ck_3d_data_explainer",
  version: 2,
  values: { pace: 1.2 },
  valuesHash: "sha256:export",
  how: "confirmed",
  proposedCookbookId: "ck_3d_data_explainer",
};

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, ORG, BRAND);
  await db.sql`insert into content_factory_sessions (id, organization_id, brand_id, title, status) values ('cfs_export', ${ORG}, ${BRAND}, 'Export', 'draft')`;
  await recordCookbookSelection(db.sql, { organizationId: ORG, sessionId: "cfs_export", record: RECORD });
});

after(async () => {
  await db.close();
});

test("with no measure recorded, the export counts the run and says that no measure exists yet", async () => {
  const exported = await cookbookResultsExport(db.sql, { organizationId: ORG, generatedAt: "2026-11-01T12:00:00.000Z" });
  assert.equal(exported.kind, "meridian.cookbook-results");
  assert.equal(exported.runs, 1);
  assert.equal(exported.unreadableRuns, 0);
  assert.equal(exported.measuresRecorded, false);
});

test("once the engine records the output's measures, the export says so, and the run is counted with them", async () => {
  await db.sql`insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state) values (${REQUEST}, ${ORG}, ${BRAND}, 'fmt_fixture_rank', 'normal', 'running', '{}')`;
  await db.sql`update content_factory_sessions set status = 'started', engine_request_id = ${REQUEST} where id = 'cfs_export'`;
  await db.sql`insert into engine_output_measures (organization_id, request_id, measures, recorded_at) values (${ORG}, ${REQUEST}, ${JSON.stringify({ integrated_lufs: -14, duration_ms: 12000 })}::jsonb, '2026-11-01T10:00:00.000Z')`;
  const exported = await cookbookResultsExport(db.sql, { organizationId: ORG, generatedAt: "2026-11-01T12:00:00.000Z" });
  assert.equal(exported.measuresRecorded, true);
  assert.equal(exported.runs, 1);
});
