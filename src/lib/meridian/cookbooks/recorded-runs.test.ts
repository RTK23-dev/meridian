// The recorded runs of a workspace (K28) on PGlite: a run with a cookbook record is read with its cookbook, version, values and how it was
// chosen; its measures are unknown; a record that cannot be read is counted; another workspace's runs are not read.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { recordedRunsOf } from "./recorded-runs.ts";
import { recordCookbookSelection } from "./run-record.ts";
import type { SelectionRecord } from "./select.ts";

const ORG = "org_recorded_runs";
const BRAND = "brand_recorded_runs";
const OTHER = "org_recorded_other";
const OTHER_BRAND = "brand_recorded_other";
let db: TestDatabase;

const RECORD: SelectionRecord = {
  cookbookId: "ck_3d_data_explainer",
  version: 2,
  values: { pace: 0.8 },
  valuesHash: "sha256:recorded",
  how: "changed",
  proposedCookbookId: "ck_3d_data_explainer",
};

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, ORG, BRAND);
  await seedWorkspace(db.sql, OTHER, OTHER_BRAND);
  await db.sql`insert into content_factory_sessions (id, organization_id, brand_id, title, status) values ('cfs_recorded', ${ORG}, ${BRAND}, 'Recorded', 'draft')`;
  await db.sql`insert into content_factory_sessions (id, organization_id, brand_id, title, status) values ('cfs_plain', ${ORG}, ${BRAND}, 'Plain', 'draft')`;
  await db.sql`insert into content_factory_sessions (id, organization_id, brand_id, title, status) values ('cfs_bad', ${ORG}, ${BRAND}, 'Bad record', 'draft')`;
  await db.sql`insert into content_factory_sessions (id, organization_id, brand_id, title, status) values ('cfs_other', ${OTHER}, ${OTHER_BRAND}, 'Other', 'draft')`;
  assert.equal(await recordCookbookSelection(db.sql, { organizationId: ORG, sessionId: "cfs_recorded", record: RECORD }), true);
  assert.equal(await recordCookbookSelection(db.sql, { organizationId: OTHER, sessionId: "cfs_other", record: RECORD }), true);
  await db.sql`update content_factory_sessions set cookbook_selection = ${JSON.stringify({ nope: 1 })}::jsonb where id = 'cfs_bad'`;
});

after(async () => {
  await db.close();
});

test("a run with a cookbook record is read with its cookbook, version, values and how it was chosen, and its measures are unknown", async () => {
  const { runs } = await recordedRunsOf(db.sql, { organizationId: ORG });
  const recorded = runs.find((run) => run.cookbookId === "ck_3d_data_explainer");
  assert.ok(recorded, "the recorded run is there");
  assert.equal(recorded.version, 2);
  assert.deepEqual(recorded.values, { pace: 0.8 });
  assert.equal(recorded.how, "changed");
  assert.equal(recorded.measures, null, "no measure of the published output is stored, so it is unknown, not 0");
});

test("a session with no record is not a run, and a record that cannot be read is counted as unreadable, not dropped", async () => {
  const { runs, unreadable } = await recordedRunsOf(db.sql, { organizationId: ORG });
  assert.equal(runs.length, 1, "the plain session is not a run");
  assert.equal(unreadable, 1, "the bad record is counted");
});

test("another workspace's runs are not read", async () => {
  const { runs, unreadable } = await recordedRunsOf(db.sql, { organizationId: OTHER });
  assert.equal(runs.length, 1, "only the other workspace's own run");
  assert.equal(unreadable, 0);
  assert.equal((await recordedRunsOf(db.sql, { organizationId: "org_nobody" })).runs.length, 0);
});
