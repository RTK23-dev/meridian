// The production VideoDNA lookup and its reuse on PGlite (intake's lookupDna port and the copy of a hit). A stored VideoDNA of the current analysis
// version for the request's format is the hit; another format, another workspace or another analysis version is a miss; a stored row that breaks
// its contract or its content hash is refused. A hit is copied into the request that uses it, parented on the stored artifact, and the copy is
// written once however often intake runs.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { newId } from "../contracts/index.ts";
import { FIXTURE_IDS, videoDnaFixture } from "../contracts/fixtures/index.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { readArtifact, writeArtifact } from "./artifact-store.ts";
import { cachedVideoDnaFor, reuseCachedVideoDna, videoDnaLookupOf } from "./video-dna-cache.ts";

const WS = "ws_dna_cache";
const OTHER_WS = "ws_dna_cache_other";
const BRAND = "brand_dna_cache";
const REQUEST = FIXTURE_IDS.request;
const REUSING_REQUEST = newId("req_");
const NOW = "2026-10-24T10:00:00.000Z";
const UNUSED_HASH = `sha256:${"0".repeat(64)}`;

let db: TestDatabase;
let storedArtifactId = "";

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  await seedWorkspace(db.sql, OTHER_WS, "brand_dna_cache_other");
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${REQUEST}, ${WS}, ${BRAND}, ${videoDnaFixture.formatId}, 'normal', 'running', '{}')
  `;
  const stored = await writeArtifact(db.sql, { organizationId: WS, requestId: REQUEST, stage: "analyze_reference", type: "video_dna", body: videoDnaFixture, createdAt: NOW });
  storedArtifactId = stored.artifactId;
});

after(async () => {
  await db.close();
});

test("a stored VideoDNA of the current analysis version for the request's format is the hit, with the artifact that holds it", async () => {
  const hit = await videoDnaLookupOf(db.sql)({ organizationId: WS, request: { format: { formatId: videoDnaFixture.formatId } } });
  assert.equal(hit?.videoDnaId, videoDnaFixture.videoDnaId);
  assert.equal(hit?.artifactId, storedArtifactId);
});

test("another format, or another workspace, is a miss: no hit, so analysis runs", async () => {
  const lookup = videoDnaLookupOf(db.sql);
  assert.equal(await lookup({ organizationId: WS, request: { format: { formatId: "ref_not_stored_anywhere" } } }), null);
  assert.equal(await lookup({ organizationId: OTHER_WS, request: { format: { formatId: videoDnaFixture.formatId } } }), null, "a VideoDNA is read in its own workspace only");
});

test("a stored row that does not match the VideoDNA contract is refused, not read as a hit or a miss", async () => {
  await db.sql`
    insert into engine_artifacts (id, organization_id, request_id, type, schema, stage, parent_ids, content_hash, body, created_at)
    values ('art_dna_bad', ${WS}, ${REQUEST}, 'video_dna', 'meridian.video_dna/v1', 'analyze_reference', '[]',
            ${UNUSED_HASH}, ${JSON.stringify({ schema: "meridian.video_dna/v1", formatId: "ref_bad_row" })}, now() + interval '1 second')
  `;
  await assert.rejects(videoDnaLookupOf(db.sql)({ organizationId: WS, request: { format: { formatId: "ref_bad_row" } } }), /no longer matches its video_dna contract/);
});

test("a stored VideoDNA of another analysis version is stale: it is a miss, so analysis runs and nothing is reused", async () => {
  const staleFormat = "ref_stale_v0";
  await db.sql`
    insert into engine_artifacts (id, organization_id, request_id, type, schema, stage, parent_ids, content_hash, body, created_at)
    values ('art_dna_stale_v0', ${WS}, ${REQUEST}, 'video_dna', 'meridian.video_dna/v0', 'analyze_reference', '[]', ${UNUSED_HASH},
            ${JSON.stringify({ ...videoDnaFixture, schema: "meridian.video_dna/v0", formatId: staleFormat })}, now() + interval '2 seconds')
  `;
  assert.equal(await videoDnaLookupOf(db.sql)({ organizationId: WS, request: { format: { formatId: staleFormat } } }), null);
});

test("a stored row whose body no longer matches its content hash is refused, not reused", async () => {
  const altered = "ref_hash_altered";
  await db.sql`
    insert into engine_artifacts (id, organization_id, request_id, type, schema, stage, parent_ids, content_hash, body, created_at)
    values ('art_dna_hash', ${WS}, ${REQUEST}, 'video_dna', 'meridian.video_dna/v1', 'analyze_reference', '[]', ${UNUSED_HASH},
            ${JSON.stringify({ ...videoDnaFixture, formatId: altered })}, now() + interval '3 seconds')
  `;
  await assert.rejects(videoDnaLookupOf(db.sql)({ organizationId: WS, request: { format: { formatId: altered } } }), /does not match its stored content hash/);
});

test("a hit is copied into the request that uses it: the copy keeps the content and the DNA id, and names the stored artifact as its parent", async () => {
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${REUSING_REQUEST}, ${WS}, ${BRAND}, ${videoDnaFixture.formatId}, 'normal', 'running', '{}')
  `;
  const cached = await cachedVideoDnaFor(db.sql, { organizationId: WS, formatId: videoDnaFixture.formatId });
  assert.ok(cached);
  const copyId = await reuseCachedVideoDna(db.sql, { organizationId: WS, requestId: REUSING_REQUEST, cached, createdAt: NOW });
  const copy = await readArtifact(db.sql, { organizationId: WS, artifactId: copyId });
  const stored = await readArtifact(db.sql, { organizationId: WS, artifactId: storedArtifactId });
  assert.equal(copy.envelope.requestId, REUSING_REQUEST, "the copy belongs to the request that reads it, so its jobs may read it");
  assert.deepEqual(copy.envelope.parentIds, [storedArtifactId], "the copy names the stored analysis as its parent");
  assert.equal(copy.envelope.contentHash, stored.envelope.contentHash, "the copy has the stored content hash");
  assert.equal(copy.envelope.body && (copy.envelope.body as { videoDnaId: string }).videoDnaId, videoDnaFixture.videoDnaId);

  const again = await reuseCachedVideoDna(db.sql, { organizationId: WS, requestId: REUSING_REQUEST, cached, createdAt: NOW });
  assert.equal(again, copyId, "an intake retry finds the copy it wrote");
  const rows = await db.sql<{ n: number }>`select count(*)::int as n from engine_artifacts where id = ${copyId}`;
  assert.equal(rows[0]?.n, 1, "the copy is written once");
});
