import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getSql, type Sql } from "../../db.ts";
import { uploadArtifactToDrive, type ArtifactUploadDeps, type ArtifactUploadRequest } from "./artifact-upload.ts";
import { createSqlArtifactUploadStore } from "./artifact-upload-sql.ts";
import { fakeDriveUpload, FAKE_DRIVE_SESSION_PREFIX, patternBytes, type ChunkAction } from "./fake-drive-upload.ts";
import { SessionSealError } from "./session-seal.ts";

// A resumable upload's session URI is sealed in Postgres and opened only by the upload loop. A process that dies mid-upload
// leaves its session behind. A new process with the same key resumes it. A process with a different key cannot.

const CHUNK = 256 * 1024;
const TOTAL = 600 * 1024;
const KEY_A = "drive-session-seal-key-A-with-sufficient-length-00";
const KEY_B = "drive-session-seal-key-B-with-sufficient-length-11";

async function withKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = key;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = saved;
  }
}

async function seed(sql: Sql) {
  const run = randomUUID();
  const userId = `user-${run}`;
  const orgId = `org-${run}`;
  const brandId = `brand-${run}`;
  await sql`insert into "user" (id, name, email, "emailVerified") values (${userId}, 'Member', ${`${userId}@example.test`}, true)`;
  await sql`insert into organizations (id, name, slug, created_by) values (${orgId}, 'Org', ${`s-${run}`}, ${userId})`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${orgId}, 'Brand', ${userId})`;
  return { orgId, brandId };
}

/** One process's deps. The store reads the key from the environment, as production does. */
function processDeps(sql: Sql, fake: ReturnType<typeof fakeDriveUpload>, sleep: (ms: number) => Promise<void>): ArtifactUploadDeps {
  return {
    store: createSqlArtifactUploadStore(sql),
    transport: { fetch: fake.fetch, accessToken: async () => "token-test" },
    chunkBytes: CHUNK,
    sleep,
  };
}

test("a session URI is stored sealed, and a process that restarts resumes the upload with the same key", async () => {
  await withKey(KEY_A, async () => {
    const sql = await getSql();
    const { orgId, brandId } = await seed(sql);
    const storageKey = `production/${randomUUID()}/artifact.png`;
    const bytes = patternBytes(TOTAL);
    const request: ArtifactUploadRequest = { organizationId: orgId, brandId, storageKey, mimeType: "image/png", bytes, metadata: { name: "artifact.png" } };
    // Chunk 1 drops, and the first process dies while it waits to retry.
    const fake = fakeDriveUpload((chunk) => (chunk.index === 1 ? ({ kind: "drop" } satisfies ChunkAction) : { kind: "accept" }));
    class ProcessStopped extends Error {}
    await assert.rejects(
      uploadArtifactToDrive(processDeps(sql, fake, async () => { throw new ProcessStopped("process stopped"); }), request),
      ProcessStopped,
    );

    const rows = await sql<{ session_uri: string; status: string; confirmed_offset: string | number }>`
      select session_uri, status, confirmed_offset from artifact_upload_sessions
      where organization_id = ${orgId} and brand_id = ${brandId} and storage_key = ${storageKey}`;
    assert.equal(rows.length, 1);
    const stored = rows[0]!.session_uri;
    assert.equal(rows[0]!.status, "uploading");
    assert.ok(stored.startsWith("sealed:v1:"), "the database holds a sealed value");
    assert.equal(stored.includes(FAKE_DRIVE_SESSION_PREFIX), false, "the database does not hold the Drive session URI");
    assert.equal(Number(rows[0]!.confirmed_offset), CHUNK, "the first chunk was confirmed before the stop");

    // A new process with the same key resumes the same Drive session from Drive's offset.
    const postsBefore = fake.requests.filter((r) => r.method === "POST").length;
    const restarted = await uploadArtifactToDrive(processDeps(sql, fake, async () => {}), request);
    assert.equal(restarted.status, "completed");
    assert.equal(fake.requests.filter((r) => r.method === "POST").length, postsBefore, "no new Drive session was started");
    assert.ok(fake.persistedBytes(fake.sessionUris()[0]!).equals(Buffer.from(bytes)), "Drive holds exactly the bytes");
  });
});

test("a process with a different key cannot open the stored session, and sends nothing to Drive", async () => {
  await withKey(KEY_A, async () => {
    const sql = await getSql();
    const { orgId, brandId } = await seed(sql);
    const storageKey = `production/${randomUUID()}/artifact.png`;
    const bytes = patternBytes(TOTAL);
    const request: ArtifactUploadRequest = { organizationId: orgId, brandId, storageKey, mimeType: "image/png", bytes, metadata: {} };
    const fake = fakeDriveUpload((chunk) => (chunk.index === 1 ? { kind: "drop" } : { kind: "accept" }));
    await assert.rejects(uploadArtifactToDrive(processDeps(sql, fake, async () => { throw new Error("stopped"); }), request));

    const before = fake.requests.length;
    await withKey(KEY_B, async () => {
      await assert.rejects(
        uploadArtifactToDrive(processDeps(sql, fake, async () => {}), request),
        (err: unknown) => err instanceof SessionSealError,
      );
    });
    assert.equal(fake.requests.length, before, "no request reached the Drive session");
  });
});

test("an upload is refused, before any Drive request, when no key is configured", async () => {
  await withKey("", async () => {
    const sql = await getSql();
    const { orgId, brandId } = await seed(sql);
    const storageKey = `production/${randomUUID()}/artifact.png`;
    const fake = fakeDriveUpload();
    const request: ArtifactUploadRequest = { organizationId: orgId, brandId, storageKey, mimeType: "image/png", bytes: patternBytes(TOTAL), metadata: {} };
    await assert.rejects(
      uploadArtifactToDrive(processDeps(sql, fake, async () => {}), request),
      (err: unknown) => err instanceof SessionSealError && /TOKEN_ENCRYPTION_KEY/.test(err.message),
    );
    assert.equal(fake.requests.length, 0, "no Drive session was started without a key to seal it");
  });
});
