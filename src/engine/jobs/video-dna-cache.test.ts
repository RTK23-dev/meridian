// The production VideoDNA lookup on PGlite (intake's lookupDna port). A stored VideoDNA for the request's format is the hit; another format, or
// another workspace, is a miss; a stored row that breaks its contract is refused rather than read.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { FIXTURE_IDS, videoDnaFixture } from "../contracts/fixtures/index.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { writeArtifact } from "./artifact-store.ts";
import { videoDnaLookupOf } from "./video-dna-cache.ts";

const WS = "ws_dna_cache";
const OTHER_WS = "ws_dna_cache_other";
const BRAND = "brand_dna_cache";
const REQUEST = FIXTURE_IDS.request;
const NOW = "2026-10-24T10:00:00.000Z";

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  await seedWorkspace(db.sql, OTHER_WS, "brand_dna_cache_other");
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${REQUEST}, ${WS}, ${BRAND}, ${videoDnaFixture.formatId}, 'normal', 'running', '{}')
  `;
  await writeArtifact(db.sql, { organizationId: WS, requestId: REQUEST, stage: "analyze_reference", type: "video_dna", body: videoDnaFixture, createdAt: NOW });
});

after(async () => {
  await db.close();
});

test("a stored VideoDNA for the request's format is the hit, and its id is returned", async () => {
  const lookup = videoDnaLookupOf(db.sql);
  const id = await lookup({ organizationId: WS, request: { format: { formatId: videoDnaFixture.formatId } } });
  assert.equal(id, videoDnaFixture.videoDnaId);
});

test("another format, or another workspace, is a miss: no id, so analysis runs", async () => {
  const lookup = videoDnaLookupOf(db.sql);
  assert.equal(await lookup({ organizationId: WS, request: { format: { formatId: "ref_not_stored_anywhere" } } }), null);
  assert.equal(await lookup({ organizationId: OTHER_WS, request: { format: { formatId: videoDnaFixture.formatId } } }), null, "a VideoDNA is read in its own workspace only");
});

test("a stored row that does not match the VideoDNA contract is refused, not read as a hit or a miss", async () => {
  await db.sql`
    insert into engine_artifacts (id, organization_id, request_id, type, schema, stage, parent_ids, content_hash, body, created_at)
    values ('art_dna_bad', ${WS}, ${REQUEST}, 'video_dna', 'meridian.video_dna/v1', 'analyze_reference', '[]',
            ${`sha256:${"0".repeat(64)}`}, ${JSON.stringify({ schema: "meridian.video_dna/v1", formatId: "ref_bad_row" })}, now() + interval '1 second')
  `;
  await assert.rejects(videoDnaLookupOf(db.sql)({ organizationId: WS, request: { format: { formatId: "ref_bad_row" } } }), /does not match its contract/);
});
