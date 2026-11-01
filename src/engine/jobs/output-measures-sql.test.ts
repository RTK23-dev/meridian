// The output measures store (K28, decision Q41) on PGlite: a recorded reading is kept as a number, a reading that is not a finite number is
// stored as null (never 0), and a second record for the same request replaces the first.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { FIXTURE_IDS, WORKSPACE_ID } from "../contracts/fixtures/index.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { measuresForStorage, sqlOutputMeasures } from "./output-measures-sql.ts";

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WORKSPACE_ID, "brand_output_measures");
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${FIXTURE_IDS.request}, ${WORKSPACE_ID}, 'brand_output_measures', 'fmt_fixture_rank', 'normal', 'running', '{}')
  `;
});

after(async () => {
  await db.close();
});

test("a finite reading is kept, and a reading that is not a finite number is stored as null, never 0", () => {
  assert.deepEqual(measuresForStorage({ integrated_lufs: -14.2, true_peak_dbtp: Number.NaN, longest_silence_ms: null, duration_ms: Infinity }), {
    integrated_lufs: -14.2,
    true_peak_dbtp: null,
    longest_silence_ms: null,
    duration_ms: null,
  });
});

test("the post-render port writes one row per request, and a second record replaces the first", async () => {
  const record = sqlOutputMeasures(db.sql);
  await record({ organizationId: WORKSPACE_ID, requestId: FIXTURE_IDS.request, measures: { integrated_lufs: -14, duration_ms: 12000 }, recordedAt: "2026-11-01T10:00:00.000Z" });
  await record({ organizationId: WORKSPACE_ID, requestId: FIXTURE_IDS.request, measures: { integrated_lufs: -13.5, true_peak_dbtp: null, duration_ms: 12000 }, recordedAt: "2026-11-01T11:00:00.000Z" });
  const rows = await db.sql<{ measures: Record<string, number | null>; recorded_at: string }>`
    select measures, recorded_at from engine_output_measures where organization_id = ${WORKSPACE_ID} and request_id = ${FIXTURE_IDS.request}
  `;
  assert.equal(rows.length, 1, "one row per request");
  assert.deepEqual(rows[0]?.measures, { integrated_lufs: -13.5, true_peak_dbtp: null, duration_ms: 12000 });
  assert.equal(rows[0]?.recorded_at, "2026-11-01T11:00:00.000Z");
});
