// The learning inputs (B14, Q17 a): test and synthetic rows are left out of what learning reads, and the count of each kind is returned for the
// learning page. Checked on PGlite with a fixture creative (id "fixture-") and a real one.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { learningInputsOf } from "./store.ts";

const ORG = "org_learning_inputs";
const BRAND = "brand_learning_inputs";
let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, ORG, BRAND);
  for (const id of ["fixture-creative-1", "creative-real-1"]) {
    await db.sql`
      insert into creative_records (id, organization_id, brand_id, origin, title, status, created_by, created_at, angle, hook_type, format, proof_type, offer, cta, visual_style, platform, emotion, product_name, claim, raw_text)
      values (${id}, ${ORG}, ${BRAND}, 'own', ${`Title ${id}`}, 'in_review', 'user_learning_inputs', now(), 'curiosity', 'question', 'reel', 'demo', 'trial', 'follow', 'bright', 'meta', 'joy', 'Kettle', 'fast', 'text')
    `;
    await db.sql`
      insert into performance_observations (id, organization_id, brand_id, creative_id, platform, impressions, clicks, conversions, spend_cents, revenue_cents, observed_on, source, created_by, external_id)
      values (${`perf-${id}`}, ${ORG}, ${BRAND}, ${id}, 'meta', 1000, 40, 4, 900, 2000, '2026-10-01', 'csv', 'user_learning_inputs', ${`ext-${id}`})
    `;
  }
});

after(async () => {
  await db.close();
});

test("a fixture creative and its performance row are left out of learning; the real ones are kept and counted", async () => {
  const inputs = await learningInputsOf(db.sql, ORG, BRAND);
  assert.deepEqual(inputs.creatives.map((creative) => creative.id), ["creative-real-1"]);
  assert.deepEqual(inputs.observations.map((row) => row.creativeId), ["creative-real-1"]);
  assert.deepEqual(inputs.excluded, { creatives: 1, performance: 1, organic: 0 });
});
