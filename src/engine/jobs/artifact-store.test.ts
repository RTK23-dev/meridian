import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { contentHash, EngineError, newId } from "../contracts/index.ts";
import { FIXTURE_IDS, fixtureId, fixtures } from "../contracts/fixtures/index.ts";
import {
  mediaKey,
  MEDIA_MIME_TYPES,
  readArtifact,
  readJobInputs,
  readMediaBytes,
  writeArtifact,
  type MediaStorePort,
} from "./artifact-store.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "./test-db.ts";

let db: TestDatabase;
const WS = "ws_fixture";
const REQ = FIXTURE_IDS.request;
const OTHER_REQ = fixtureId("req_", 77);
const CREATED = "2026-10-13T09:00:05.000Z";

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, "brand_fixture");
  await seedWorkspace(db.sql, "ws_other");
  for (const [id, org] of [
    [REQ, WS],
    [OTHER_REQ, WS],
  ] as const) {
    await db.sql`
      insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
      values (${id}, ${org}, 'brand_fixture', 'fmt_fixture', 'normal', 'running', '{}')
    `;
  }
});

after(async () => {
  await db.close();
});

/** An in-memory object store with the port's shape. Keys are the same ones Meridian's store would receive. */
function fakeStore(): { port: MediaStorePort; objects: Map<string, { bytes: Uint8Array; mimeType: string }> } {
  const objects = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  const port: MediaStorePort = {
    put: async (input) => {
      objects.set(input.key, { bytes: input.bytes, mimeType: input.mimeType });
      return { key: input.key, checksum: contentHash(input.bytes), size: input.bytes.byteLength };
    },
    get: async (_organizationId, _brandId, key) => objects.get(key) ?? null,
  };
  return { port, objects };
}

test("a JSON artifact round-trips: the body comes back equal, and its hash is the contract hash", async () => {
  const written = await writeArtifact(db.sql, {
    organizationId: WS,
    requestId: REQ,
    stage: "intake",
    type: "validated_request",
    body: fixtures.validatedRequest,
    parentIds: [],
    createdAt: CREATED,
  });
  assert.equal(written.schema, "meridian.validated_request/v1");
  assert.equal(written.workspaceId, WS);
  assert.equal(written.contentHash, contentHash(fixtures.validatedRequest));

  const read = await readArtifact(db.sql, { organizationId: WS, artifactId: written.artifactId });
  assert.deepEqual(read.envelope.body, fixtures.validatedRequest);
  assert.equal(read.envelope.contentHash, written.contentHash);
  assert.equal(read.envelope.createdAt, CREATED);
  assert.equal(read.storage, null);
});

test("a body that fails its contract is refused on write, and nothing is stored", async () => {
  const before = await db.sql<{ n: number }>`select count(*)::int as n from engine_artifacts where request_id = ${REQ} and type = 'scene_plan'`;
  await assert.rejects(
    writeArtifact(db.sql, {
      organizationId: WS,
      requestId: REQ,
      stage: "plan",
      type: "scene_plan",
      body: { ...fixtures.scenePlan, estimatedUsd: -1 },
      createdAt: CREATED,
    }),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input" && /estimatedUsd/.test(error.message),
  );
  const after = await db.sql<{ n: number }>`select count(*)::int as n from engine_artifacts where request_id = ${REQ} and type = 'scene_plan'`;
  assert.equal(after[0]?.n, before[0]?.n);
});

test("a parent that is not an artifact id is refused, and a request outside the workspace is not_found", async () => {
  await assert.rejects(
    writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "plan", type: "scene_plan", body: fixtures.scenePlan, parentIds: ["take_1"], createdAt: CREATED }),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );
  await assert.rejects(
    writeArtifact(db.sql, { organizationId: "ws_other", requestId: REQ, stage: "plan", type: "scene_plan", body: fixtures.scenePlan, createdAt: CREATED }),
    (error: unknown) => error instanceof EngineError && error.kind === "not_found",
  );
});

test("an artifact is immutable: an UPDATE is refused by the database, and no code path updates one", async () => {
  const written = await writeArtifact(db.sql, {
    organizationId: WS,
    requestId: REQ,
    stage: "plan",
    type: "scene_plan",
    body: fixtures.scenePlan,
    createdAt: CREATED,
  });
  await assert.rejects(
    db.sql`update engine_artifacts set body = '{}' where id = ${written.artifactId}`,
    /immutable/,
  );
  const read = await readArtifact(db.sql, { organizationId: WS, artifactId: written.artifactId });
  assert.deepEqual(read.envelope.body, fixtures.scenePlan);
});

test("an artifact is read only inside its own workspace", async () => {
  const written = await writeArtifact(db.sql, {
    organizationId: WS,
    requestId: REQ,
    stage: "intake",
    type: "validated_request",
    body: fixtures.validatedRequest,
    createdAt: CREATED,
  });
  await assert.rejects(readArtifact(db.sql, { organizationId: "ws_other", artifactId: written.artifactId }), (error: unknown) => error instanceof EngineError && error.kind === "not_found");
});

test("a stored body that no longer matches its hash is reported as corrupt on read, never returned", async () => {
  const artifactId = newId("art_");
  await db.sql`
    insert into engine_artifacts (id, organization_id, request_id, type, schema, stage, parent_ids, content_hash, body, created_at)
    values (${artifactId}, ${WS}, ${REQ}, 'take_verdict', 'meridian.take_verdict/v1', 'check_take', '[]',
      ${`sha256:${"0".repeat(64)}`}, ${JSON.stringify(fixtures.takeVerdict)}, ${CREATED})
  `;
  await assert.rejects(
    readArtifact(db.sql, { organizationId: WS, artifactId }),
    (error: unknown) => error instanceof EngineError && error.kind === "internal" && /content hash/.test(error.message),
  );
});

test("media is stored under the Bible 5.2 key, with its bytes and hash checked on read", async () => {
  const { port, objects } = fakeStore();
  const bytes = new TextEncoder().encode("fixture mp4 bytes");
  const written = await writeArtifact(db.sql, {
    organizationId: WS,
    requestId: REQ,
    stage: "render",
    type: "rendered_video",
    body: fixtures.renderedVideo,
    createdAt: CREATED,
    media: { store: port, brandId: "brand_fixture", extension: "mp4", bytes },
  });
  assert.equal(written.contentHash, contentHash(bytes), "the hash of media is the hash of its bytes");
  const expectedKey = `engine/${WS}/${REQ}/render/${written.artifactId}.mp4`;
  assert.ok(objects.has(expectedKey), "the object sits at engine/{workspaceId}/{requestId}/{stage}/{artifactId}.{ext}");
  assert.equal(objects.get(expectedKey)?.mimeType, MEDIA_MIME_TYPES.mp4);

  const stored = await readArtifact(db.sql, { organizationId: WS, artifactId: written.artifactId });
  assert.deepEqual(stored.storage, { key: expectedKey, mimeType: "video/mp4", bytes: bytes.byteLength });
  const read = await readMediaBytes(port, { organizationId: WS, brandId: "brand_fixture", stored });
  assert.deepEqual(Array.from(read), Array.from(bytes));

  objects.set(expectedKey, { bytes: new TextEncoder().encode("swapped"), mimeType: "video/mp4" });
  await assert.rejects(
    readMediaBytes(port, { organizationId: WS, brandId: "brand_fixture", stored }),
    (error: unknown) => error instanceof EngineError && error.kind === "internal",
  );
});

test("the object key refuses a part that would escape its folder", () => {
  assert.equal(
    mediaKey({ workspaceId: WS, requestId: REQ, stage: "render", artifactId: "art_X", extension: "mp4" }),
    `engine/${WS}/${REQ}/render/art_X.mp4`,
  );
  assert.throws(
    () => mediaKey({ workspaceId: WS, requestId: REQ, stage: "../render", artifactId: "art_X", extension: "mp4" }),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );
  assert.throws(
    () => mediaKey({ workspaceId: "a/b", requestId: REQ, stage: "render", artifactId: "art_X", extension: "mp4" }),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );
});

test("a job reads exactly its named inputs, and an input from another request is refused", async () => {
  const mine = await writeArtifact(db.sql, {
    organizationId: WS,
    requestId: REQ,
    stage: "intake",
    type: "validated_request",
    body: fixtures.validatedRequest,
    createdAt: CREATED,
  });
  const theirs = await writeArtifact(db.sql, {
    organizationId: WS,
    requestId: OTHER_REQ,
    stage: "intake",
    type: "validated_request",
    body: { ...fixtures.validatedRequest, requestId: OTHER_REQ, request: { ...fixtures.productionRequest, requestId: OTHER_REQ } },
    createdAt: CREATED,
  });
  const inputs = await readJobInputs(db.sql, { organizationId: WS, requestId: REQ, inputArtifactIds: [mine.artifactId] });
  assert.equal(inputs.length, 1);
  await assert.rejects(
    readJobInputs(db.sql, { organizationId: WS, requestId: REQ, inputArtifactIds: [theirs.artifactId] }),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );
});

test("the write refuses a body of the wrong type for its artifact type", async () => {
  await assert.rejects(
    writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "plan", type: "take", body: fixtures.scenePlan, createdAt: CREATED }),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );
});
