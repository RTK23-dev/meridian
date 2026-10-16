import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { EngineError } from "../contracts/index.ts";
import { FIXTURE_IDS, fixtureId } from "../contracts/fixtures/index.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { writeManifestRow } from "./manifest-store.ts";

const WS = "ws_manifest_rows";
const OTHER = "ws_manifest_rows_other";
const REQ = FIXTURE_IDS.request;
const AT = "2026-10-15T12:00:00.000Z";
const ARTIFACT = fixtureId("art_", 150);

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, "brand_manifest");
  await seedWorkspace(db.sql, OTHER, "brand_other_manifest");
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${REQ}, ${WS}, 'brand_manifest', 'fmt_manifest', 'normal', 'delivered', '{}')
  `;
});

after(async () => {
  await db.close();
});

test("a manifest row is written once under its artifact id, with the body's content hash", async () => {
  const body = { schema: "meridian.manifest/v2", videoId: FIXTURE_IDS.video, shots: [] };
  const first = await writeManifestRow(db.sql, { organizationId: WS, requestId: REQ, artifactId: ARTIFACT, variantOf: null, body, createdAt: AT });
  assert.equal(first.created, true);
  assert.match(first.contentHash, /^sha256:[0-9a-f]{64}$/);
  const again = await writeManifestRow(db.sql, { organizationId: WS, requestId: REQ, artifactId: ARTIFACT, variantOf: null, body, createdAt: AT });
  assert.equal(again.created, false, "the same manifest is not written twice");
  const rows = await db.sql<{ n: number; hash: string }>`select count(*)::int as n, max(content_hash) as hash from engine_manifests where id = ${ARTIFACT}`;
  assert.equal(rows[0]?.n, 1);
  assert.equal(rows[0]?.hash, first.contentHash);
});

test("a manifest is never overwritten: a different body under the same id is refused", async () => {
  await assert.rejects(
    () =>
      writeManifestRow(db.sql, {
        organizationId: WS,
        requestId: REQ,
        artifactId: ARTIFACT,
        variantOf: null,
        body: { schema: "meridian.manifest/v2", videoId: FIXTURE_IDS.video, shots: [{ shotId: "changed" }] },
        createdAt: AT,
      }),
    (error: unknown) => error instanceof EngineError && error.kind === "conflict",
  );
});

test("a manifest row of another workspace is not reached by a write under its id", async () => {
  await assert.rejects(
    () => writeManifestRow(db.sql, { organizationId: OTHER, requestId: REQ, artifactId: ARTIFACT, variantOf: null, body: { x: 1 }, createdAt: AT }),
    (error: unknown) => error instanceof Error,
  );
});

test("a variant's manifest records the master EDL it varies", async () => {
  const variantArtifact = fixtureId("art_", 151);
  await writeManifestRow(db.sql, {
    organizationId: WS,
    requestId: REQ,
    artifactId: variantArtifact,
    variantOf: FIXTURE_IDS.edl,
    body: { schema: "meridian.manifest/v2", variantOf: FIXTURE_IDS.edl },
    createdAt: AT,
  });
  const rows = await db.sql<{ variant_of: string | null }>`select variant_of from engine_manifests where id = ${variantArtifact}`;
  assert.equal(rows[0]?.variant_of, FIXTURE_IDS.edl);
});
