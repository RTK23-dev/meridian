// Seeds a DEMO batch for the acceptance brand: two videos the engine reports as delivered and one draft. These are fixture rows, titled
// "DEMO (fixture)", so the review screen can be walked in the browser. No video was rendered, no provider was called, and no file exists.
// Run it while the dev server is stopped, with: node --experimental-strip-types scripts/release-acceptance/seed-demo-batch.mjs <data directory>

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { advance } from "../../src/engine/jobs/orchestrator.ts";

const dataDir = process.argv[2];
if (!dataDir) throw new Error("Give the data directory.");
const db = new PGlite(dataDir, { extensions: { vector } });
await db.waitReady;
try {
  const brand = (await db.query(`select id, organization_id as org from brands where name = 'Acceptance Brand' and deleted_at is null limit 1`)).rows[0];
  if (!brand) throw new Error("No Acceptance Brand. Create it first.");
  const started = (requestId) => {
    const first = advance(null, { type: "start", organizationId: brand.org, requestId, priority: "normal", cachedDna: false, variantCount: 0, requestArtifactId: "art_demo" });
    return JSON.parse(JSON.stringify(first.state));
  };
  const deliveredState = (requestId, manifestId) => {
    const state = started(requestId);
    state.manifestId = manifestId;
    state.nodes.intake = { ...state.nodes.intake, status: "passed" };
    return state;
  };
  await db.query(`delete from content_factory_batches where id = 'batch_demo'`);
  await db.query(`delete from content_factory_sessions where id like 'demo_%'`);
  await db.query(`delete from engine_requests where id like 'req_demo_%'`);
  const videos = [
    ["demo_a", "DEMO (fixture) video A", "req_demo_a", "man_demo_a"],
    ["demo_b", "DEMO (fixture) video B", "req_demo_b", "man_demo_b"],
    ["demo_c", "DEMO (fixture) video C (draft)", null, null],
  ];
  for (const [id, title, requestId, manifestId] of videos) {
    if (requestId) {
      await db.query(
        `insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state, current_stage) values ($1, $2, $3, 'fmt_demo', 'normal', 'delivered', $4, 'deliver')`,
        [requestId, brand.org, brand.id, JSON.stringify(deliveredState(requestId, manifestId))],
      );
      await db.query(
        `insert into content_factory_sessions (id, organization_id, brand_id, title, status, engine_request_id, started_at, budget_usd) values ($1, $2, $3, $4, 'started', $5, now(), 2)`,
        [id, brand.org, brand.id, title, requestId],
      );
    } else {
      await db.query(`insert into content_factory_sessions (id, organization_id, brand_id, title, status, budget_usd) values ($1, $2, $3, $4, 'draft', 2)`, [id, brand.org, brand.id, title]);
    }
  }
  await db.query(`insert into content_factory_batches (id, organization_id, brand_id, title, budget_usd, created_by) values ('batch_demo', $1, $2, 'DEMO (fixture) batch', 6, 'demo')`, [brand.org, brand.id]);
  for (const [position, [id]] of videos.entries()) {
    await db.query(`insert into content_factory_batch_items (id, organization_id, batch_id, session_id, position) values ($1, $2, 'batch_demo', $3, $4)`, [`item_demo_${position}`, brand.org, id, position]);
  }
  console.log("Seeded one DEMO batch: two delivered fixture videos and one draft.");
} finally {
  await db.close();
}
