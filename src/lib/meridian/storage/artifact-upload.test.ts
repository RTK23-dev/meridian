import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { createPoolSql, getSql, type Sql } from "../../db.ts";
import {
  ArtifactUploadConflictError,
  resumeArtifactUpload,
  uploadArtifactToDrive,
  type ArtifactUploadDeps,
  type ArtifactUploadRequest,
} from "./artifact-upload.ts";
import { createSqlArtifactUploadStore } from "./artifact-upload-sql.ts";
import { startDriveSession, sendDriveChunk, type ResumableTransport } from "./drive-resumable.ts";
import { fakeDriveUpload, FAKE_DRIVE_SESSION_PREFIX, patternBytes } from "./fake-drive-upload.ts";

// Each scenario runs on the embedded database, and on PostgreSQL when MERIDIAN_PG_TEST_URL names a migrated database.

const CHUNK = 256 * 1024;
const TOTAL = 600 * 1024; // 614400 bytes: chunks of 262144, 262144 and 90112.

type Backend = { name: string; sql: Sql; close: () => Promise<void> };

async function openBackends(): Promise<Backend[]> {
  const backends: Backend[] = [{ name: "embedded", sql: await getSql(), close: async () => {} }];
  const url = process.env.MERIDIAN_PG_TEST_URL?.trim();
  if (url) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url });
    backends.push({ name: "postgres", sql: createPoolSql(pool), close: () => pool.end() });
  }
  return backends;
}

const backends = await openBackends();
after(async () => {
  for (const backend of backends) await backend.close();
});

type Tenants = { userId: string; orgA: string; brandA: string; brandA2: string; orgB: string; brandB: string };

/** Two workspaces. Organization A has two brands, so a same-organization, different-brand check is possible. */
async function seedTenants(sql: Sql): Promise<Tenants> {
  const run = randomUUID();
  const t: Tenants = {
    userId: `user-${run}`,
    orgA: `org-a-${run}`,
    brandA: `brand-a-${run}`,
    brandA2: `brand-a2-${run}`,
    orgB: `org-b-${run}`,
    brandB: `brand-b-${run}`,
  };
  await sql`insert into "user" (id, name, email, "emailVerified") values (${t.userId}, 'Member', ${`${t.userId}@example.test`}, true)`;
  await sql`insert into organizations (id, name, slug, created_by) values (${t.orgA}, 'Org A', ${`a-${run}`}, ${t.userId})`;
  await sql`insert into organizations (id, name, slug, created_by) values (${t.orgB}, 'Org B', ${`b-${run}`}, ${t.userId})`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${t.brandA}, ${t.orgA}, 'Brand A', ${t.userId})`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${t.brandA2}, ${t.orgA}, 'Brand A2', ${t.userId})`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${t.brandB}, ${t.orgB}, 'Brand B', ${t.userId})`;
  return t;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function keyFor(orgId: string, brandId: string): string {
  return `${orgId}/${brandId}/production/${randomUUID()}/artifact.png`;
}

function requestFor(scope: { organizationId: string; brandId: string }, storageKey: string, bytes: Uint8Array): ArtifactUploadRequest {
  return { ...scope, storageKey, mimeType: "image/png", bytes, metadata: { name: "artifact.png" } };
}

/** The deps one process would build. A new call with the same fake is a new process talking to the same Drive. */
function depsFor(sql: Sql, fake: ReturnType<typeof fakeDriveUpload>, sleeps: number[], overrides: Partial<ArtifactUploadDeps> = {}): ArtifactUploadDeps {
  return {
    store: createSqlArtifactUploadStore(sql),
    transport: { fetch: fake.fetch, accessToken: async () => "token-test" },
    chunkBytes: CHUNK,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  };
}

async function sessionRow(sql: Sql, id: string) {
  const rows = await sql<{
    status: string;
    confirmed_offset: string | number;
    attempts: number;
    last_error: string | null;
    session_uri: string;
    provider_file_id: string | null;
    storage_object_id: string | null;
  }>`select status, confirmed_offset, attempts, last_error, session_uri, provider_file_id, storage_object_id
     from artifact_upload_sessions where id = ${id}`;
  const row = rows[0];
  assert.ok(row, `session ${id} exists`);
  return { ...row, confirmed_offset: Number(row.confirmed_offset) };
}

/** Starts an upload that stops during its first backoff, after the chunk at index 1 drops. The row stays active. */
async function leaveActiveSession(sql: Sql, fake: ReturnType<typeof fakeDriveUpload>, scope: { organizationId: string; brandId: string }, storageKey: string, bytes: Uint8Array) {
  const crash = new Error("process stopped during backoff");
  await assert.rejects(
    uploadArtifactToDrive(depsFor(sql, fake, [], { sleep: async () => { throw crash; } }), requestFor(scope, storageKey, bytes)),
    (err: unknown) => err === crash,
  );
  const rows = await sql<{ id: string }>`select id from artifact_upload_sessions
    where organization_id = ${scope.organizationId} and brand_id = ${scope.brandId} and storage_key = ${storageKey} and status = 'uploading'`;
  assert.equal(rows.length, 1, "one active session remains after the process stopped");
  return rows[0]!.id;
}

for (const backend of backends) {
  const { sql } = backend;

  test(`${backend.name}: a new upload is sent in 256 KiB-aligned chunks and records the session and the storage object row`, async () => {
    const t = await seedTenants(sql);
    const fake = fakeDriveUpload();
    const bytes = patternBytes(TOTAL);
    const storageKey = keyFor(t.orgA, t.brandA);
    const sleeps: number[] = [];

    const outcome = await uploadArtifactToDrive(depsFor(sql, fake, sleeps), {
      ...requestFor({ organizationId: t.orgA, brandId: t.brandA }, storageKey, bytes),
      storageObject: { lifecycle: "stored" },
    });
    assert.equal(outcome.status, "completed");
    if (outcome.status !== "completed") return;
    assert.equal(outcome.resumed, false);
    const [driveFileId] = fake.fileIds();
    assert.equal(outcome.file.id, driveFileId);
    assert.equal(outcome.file.size, TOTAL);
    assert.deepEqual(sleeps, [], "no retry was needed");

    const [post] = fake.requests.filter((r) => r.method === "POST");
    assert.equal(post!.headers["x-upload-content-length"], String(TOTAL));
    assert.equal(post!.headers["x-upload-content-type"], "image/png");
    assert.equal(post!.headers.authorization, "Bearer token-test");
    assert.deepEqual(fake.chunkRanges(), [
      `bytes 0-${CHUNK - 1}/${TOTAL}`,
      `bytes ${CHUNK}-${2 * CHUNK - 1}/${TOTAL}`,
      `bytes ${2 * CHUNK}-${TOTAL - 1}/${TOTAL}`,
    ]);
    const putLengths = fake.requests.filter((r) => r.method === "PUT").map((r) => r.body?.byteLength);
    assert.deepEqual(putLengths, [CHUNK, CHUNK, TOTAL - 2 * CHUNK]);
    assert.ok(fake.persistedBytes(fake.sessionUris()[0]!).equals(Buffer.from(bytes)), "Drive holds exactly the bytes sent");

    const row = await sessionRow(sql, outcome.sessionId);
    assert.equal(row.status, "completed");
    assert.equal(row.confirmed_offset, TOTAL);
    assert.equal(row.provider_file_id, driveFileId);
    assert.ok(row.storage_object_id, "the session links to its storage object row");

    const stored = await sql<{ provider: string; provider_file_id: string; size_bytes: string | number; sha256: string; lifecycle: string }>`
      select provider, provider_file_id, size_bytes, sha256, lifecycle from storage_objects
      where organization_id = ${t.orgA} and brand_id = ${t.brandA} and name = ${storageKey}`;
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.provider, "google_drive");
    assert.equal(stored[0]!.provider_file_id, driveFileId);
    assert.equal(Number(stored[0]!.size_bytes), TOTAL);
    assert.equal(stored[0]!.sha256, sha256(bytes));
    assert.equal(stored[0]!.lifecycle, "stored");

    const dump = JSON.stringify(await sql`select * from artifact_upload_sessions where id = ${outcome.sessionId}`);
    assert.equal(dump.includes("token-test"), false, "the Drive access token is never stored");

    // A completed session is not uploaded again.
    const before = fake.requests.length;
    const again = await resumeArtifactUpload(depsFor(sql, fake, sleeps), {
      organizationId: t.orgA,
      brandId: t.brandA,
      sessionId: outcome.sessionId,
      bytes,
      metadata: {},
    });
    assert.equal(again.status, "completed");
    assert.equal(fake.requests.length, before, "no Drive request for a completed session");
  });

  test(`${backend.name}: a dropped connection is followed by a status query, then a resume from the confirmed offset`, async () => {
    const t = await seedTenants(sql);
    // Chunk index 1 drops after Drive keeps 100000 of its bytes.
    const fake = fakeDriveUpload((chunk) => (chunk.index === 1 ? { kind: "drop", persist: 100_000 } : { kind: "accept" }));
    const bytes = patternBytes(TOTAL);
    const sleeps: number[] = [];

    const outcome = await uploadArtifactToDrive(depsFor(sql, fake, sleeps), requestFor({ organizationId: t.orgA, brandId: t.brandA }, keyFor(t.orgA, t.brandA), bytes));
    assert.equal(outcome.status, "completed");
    assert.deepEqual(sleeps, [1000], "one backoff before the status query");
    assert.deepEqual(fake.requests.filter((r) => r.method === "PUT" && r.headers["content-range"]?.startsWith("bytes */")).map((r) => r.headers["content-range"]), [
      `bytes */${TOTAL}`,
    ]);
    assert.deepEqual(fake.chunkRanges(), [
      `bytes 0-${CHUNK - 1}/${TOTAL}`,
      `bytes ${CHUNK}-${2 * CHUNK - 1}/${TOTAL}`,
      `bytes ${CHUNK + 100_000}-${TOTAL - 1}/${TOTAL}`,
    ], "the resume starts at 362144, the offset Drive confirmed, and its last chunk is the rest of the file");
    assert.ok(fake.persistedBytes(fake.sessionUris()[0]!).equals(Buffer.from(bytes)));
    const row = await sessionRow(sql, outcome.sessionId);
    assert.equal(row.status, "completed");
    assert.equal(row.attempts, 0, "progress resets the attempt count");
  });

  test(`${backend.name}: a restarted process resumes the same session row from Drive's offset without starting a new session`, async () => {
    const t = await seedTenants(sql);
    const scope = { organizationId: t.orgA, brandId: t.brandA };
    const storageKey = keyFor(t.orgA, t.brandA);
    const bytes = patternBytes(TOTAL);
    const fake = fakeDriveUpload((chunk) => (chunk.index === 1 ? { kind: "drop" } : { kind: "accept" }));

    const sessionId = await leaveActiveSession(sql, fake, scope, storageKey, bytes);
    const beforeStatus = await sessionRow(sql, sessionId);
    assert.equal(beforeStatus.confirmed_offset, CHUNK, "the first chunk was confirmed before the stop");
    assert.equal(beforeStatus.attempts, 1);
    assert.ok(beforeStatus.session_uri.startsWith(FAKE_DRIVE_SESSION_PREFIX));

    // A new process: new store, new deps, same database row and same Drive.
    const posts = fake.requests.filter((r) => r.method === "POST").length;
    const beforeRestart = fake.requests.length;
    const sleeps: number[] = [];
    const second = await uploadArtifactToDrive(depsFor(sql, fake, sleeps), requestFor(scope, storageKey, bytes));
    assert.equal(second.status, "completed");
    if (second.status !== "completed") return;
    assert.equal(second.resumed, true);
    assert.equal(second.sessionId, sessionId, "the same row is continued");
    assert.equal(fake.requests.filter((r) => r.method === "POST").length, posts, "no new Drive session was started");
    assert.deepEqual(sleeps, []);
    const afterRestart = fake.requests.slice(beforeRestart).filter((r) => r.method === "PUT").map((r) => r.headers["content-range"]);
    assert.deepEqual(afterRestart, [`bytes */${TOTAL}`, `bytes ${CHUNK}-${2 * CHUNK - 1}/${TOTAL}`, `bytes ${2 * CHUNK}-${TOTAL - 1}/${TOTAL}`]);
    assert.ok(fake.persistedBytes(beforeStatus.session_uri).equals(Buffer.from(bytes)));
  });

  test(`${backend.name}: a process that loses the start race continues the stored Drive session from Drive's offset`, async () => {
    const t = await seedTenants(sql);
    const scope = { organizationId: t.orgA, brandId: t.brandA };
    const storageKey = keyFor(t.orgA, t.brandA);
    const bytes = patternBytes(TOTAL);
    const fake = fakeDriveUpload();
    const transport: ResumableTransport = { fetch: fake.fetch, accessToken: async () => "token-test" };

    // Another process started its session and sent the first chunk, then stored its URI first.
    const winnerUri = await startDriveSession(transport, { metadata: {}, mimeType: "image/png", totalBytes: TOTAL });
    await sendDriveChunk(transport, { sessionUri: winnerUri, totalBytes: TOTAL, offset: 0, chunk: bytes.subarray(0, CHUNK) });

    const real = createSqlArtifactUploadStore(sql);
    const losing = {
      ...real,
      setSessionUri: async (s: typeof scope, sessionId: string, uri: string) => {
        await sql`update artifact_upload_sessions set session_uri = ${winnerUri} where id = ${sessionId} and session_uri = ''`;
        return real.setSessionUri(s, sessionId, uri);
      },
    };
    const before = fake.requests.length;
    const outcome = await uploadArtifactToDrive(depsFor(sql, fake, [], { store: losing }), requestFor(scope, storageKey, bytes));
    assert.equal(outcome.status, "completed");
    const sent = fake.requests.slice(before).filter((r) => r.method === "PUT").map((r) => r.headers["content-range"]);
    assert.deepEqual(sent, [`bytes */${TOTAL}`, `bytes ${CHUNK}-${2 * CHUNK - 1}/${TOTAL}`, `bytes ${2 * CHUNK}-${TOTAL - 1}/${TOTAL}`], "the loser never re-sends the first chunk");
    assert.ok(fake.persistedBytes(winnerUri).equals(Buffer.from(bytes)));
    if (outcome.status === "completed") assert.equal((await sessionRow(sql, outcome.sessionId)).session_uri, winnerUri);
  });

  test(`${backend.name}: two processes starting the same key at once end up on one session`, async () => {
    const t = await seedTenants(sql);
    const scope = { organizationId: t.orgA, brandId: t.brandA };
    const storageKey = keyFor(t.orgA, t.brandA);
    const bytes = patternBytes(TOTAL);
    const fake = fakeDriveUpload((chunk) => (chunk.index === 1 ? { kind: "drop" } : { kind: "accept" }));
    // The other process's session is already active. This process's first lookup misses it, so its insert loses the race.
    const otherSessionId = await leaveActiveSession(sql, fake, scope, storageKey, bytes);
    const real = createSqlArtifactUploadStore(sql);
    let misses = 1;
    const racing = {
      ...real,
      findActive: async (s: typeof scope, key: string) => (misses-- > 0 ? null : real.findActive(s, key)),
    };
    const outcome = await uploadArtifactToDrive(depsFor(sql, fake, [], { store: racing }), requestFor(scope, storageKey, bytes));
    assert.equal(outcome.status, "completed");
    if (outcome.status !== "completed") return;
    assert.equal(outcome.resumed, true);
    assert.equal(outcome.sessionId, otherSessionId, "the loser continues the winner's session");
    const rows = await sql<{ n: number }>`select count(*)::int as n from artifact_upload_sessions
      where organization_id = ${t.orgA} and brand_id = ${t.brandA} and storage_key = ${storageKey}`;
    assert.equal(Number(rows[0]!.n), 1, "only one session row exists for the key");
  });

  test(`${backend.name}: after the retry cap the upload stays failed and visible, and a later attempt is a new session`, async () => {
    const t = await seedTenants(sql);
    const scope = { organizationId: t.orgA, brandId: t.brandA };
    const storageKey = keyFor(t.orgA, t.brandA);
    const bytes = patternBytes(TOTAL);
    const fake = fakeDriveUpload();
    fake.control.failAllWith = 503;
    const sleeps: number[] = [];

    const failed = await uploadArtifactToDrive(depsFor(sql, fake, sleeps, { maxFailures: 3 }), requestFor(scope, storageKey, bytes));
    assert.equal(failed.status, "failed");
    if (failed.status !== "failed") return;
    assert.equal(failed.attempts, 3);
    assert.match(failed.reason, /after 3 attempts/);
    assert.match(failed.reason, /HTTP 503/);
    assert.deepEqual(sleeps, [1000, 2000], "exponential backoff between the three attempts");

    const row = await sessionRow(sql, failed.sessionId);
    assert.equal(row.status, "failed");
    assert.equal(row.attempts, 3);
    assert.match(row.last_error ?? "", /HTTP 503/);
    const stored = await sql`select id from storage_objects where organization_id = ${t.orgA} and brand_id = ${t.brandA} and name = ${storageKey}`;
    assert.equal(stored.length, 0, "no storage object row is written for a failed upload");

    // Drive recovers. The failed row stays failed; the next attempt is a new session that completes.
    fake.control.failAllWith = null;
    const retry = await uploadArtifactToDrive(depsFor(sql, fake, []), requestFor(scope, storageKey, bytes));
    assert.equal(retry.status, "completed");
    if (retry.status !== "completed") return;
    assert.notEqual(retry.sessionId, failed.sessionId);
    assert.equal((await sessionRow(sql, failed.sessionId)).status, "failed", "the failed session is not revived");
  });

  test(`${backend.name}: a rejection from Drive fails at once, with no retry`, async () => {
    for (const code of [403, 404]) {
      const t = await seedTenants(sql);
      const fake = fakeDriveUpload(() => ({ kind: "status", code }));
      const sleeps: number[] = [];
      const outcome = await uploadArtifactToDrive(depsFor(sql, fake, sleeps), requestFor({ organizationId: t.orgA, brandId: t.brandA }, keyFor(t.orgA, t.brandA), patternBytes(TOTAL)));
      assert.equal(outcome.status, "failed", `HTTP ${code} fails the upload`);
      if (outcome.status !== "failed") return;
      assert.equal(outcome.attempts, 1);
      assert.deepEqual(sleeps, [], `HTTP ${code} is not retried`);
      assert.equal((await sessionRow(sql, outcome.sessionId)).status, "failed");
    }
  });

  test(`${backend.name}: tenant isolation: another workspace cannot read or resume a session, and gets its own session`, async () => {
    const t = await seedTenants(sql);
    const scope = { organizationId: t.orgA, brandId: t.brandA };
    const storageKey = keyFor(t.orgA, t.brandA);
    const bytes = patternBytes(TOTAL);
    const fake = fakeDriveUpload((chunk) => (chunk.index === 1 ? { kind: "drop" } : { kind: "accept" }));
    const sessionId = await leaveActiveSession(sql, fake, scope, storageKey, bytes);
    const aSessionUri = (await sessionRow(sql, sessionId)).session_uri;
    const store = createSqlArtifactUploadStore(sql);
    const other = { organizationId: t.orgB, brandId: t.brandB };

    assert.equal(await store.load(other, sessionId), null, "organization B cannot read A's session");
    assert.equal(await store.load({ organizationId: t.orgA, brandId: t.brandA2 }, sessionId), null, "another brand cannot read it either");

    const beforeAttempt = fake.requests.length;
    const attempt = await resumeArtifactUpload(depsFor(sql, fake, []), { ...other, sessionId, bytes, metadata: {} });
    assert.deepEqual(attempt, { status: "not_found" }, "organization B cannot resume A's session");
    assert.equal(fake.requests.length, beforeAttempt, "no request reached A's Drive session");

    // Organization B uploading under the same key gets its own session. It never joins A's.
    const own = await uploadArtifactToDrive(depsFor(sql, fake, []), requestFor(other, storageKey, bytes));
    assert.equal(own.status, "completed");
    if (own.status !== "completed") return;
    assert.equal(own.resumed, false);
    assert.notEqual(own.sessionId, sessionId);
    assert.ok(fake.requests.slice(beforeAttempt).every((r) => r.url !== aSessionUri), "B never sent a request to A's session URI");

    const aRow = await sessionRow(sql, sessionId);
    assert.equal(aRow.status, "uploading", "A's session is untouched");
    assert.equal(aRow.confirmed_offset, CHUNK);
  });

  test(`${backend.name}: bytes that differ from the active session are refused before any Drive request`, async () => {
    const t = await seedTenants(sql);
    const scope = { organizationId: t.orgA, brandId: t.brandA };
    const storageKey = keyFor(t.orgA, t.brandA);
    const bytes = patternBytes(TOTAL);
    const fake = fakeDriveUpload((chunk) => (chunk.index === 1 ? { kind: "drop" } : { kind: "accept" }));
    const sessionId = await leaveActiveSession(sql, fake, scope, storageKey, bytes);
    const before = fake.requests.length;
    const otherBytes = patternBytes(TOTAL + 1);

    await assert.rejects(uploadArtifactToDrive(depsFor(sql, fake, []), requestFor(scope, storageKey, otherBytes)), ArtifactUploadConflictError);
    await assert.rejects(
      resumeArtifactUpload(depsFor(sql, fake, []), { ...scope, sessionId, bytes: otherBytes, metadata: {} }),
      ArtifactUploadConflictError,
    );
    assert.equal(fake.requests.length, before, "nothing was sent to Drive");
  });

  test(`${backend.name}: a storage object that already holds different bytes under the name fails the upload and writes nothing`, async () => {
    const t = await seedTenants(sql);
    const scope = { organizationId: t.orgA, brandId: t.brandA };
    const storageKey = keyFor(t.orgA, t.brandA);
    await sql`insert into storage_objects (id, organization_id, brand_id, provider, provider_file_id, name, mime_type, size_bytes, sha256, lifecycle, metadata)
      values (${`so-${randomUUID()}`}, ${t.orgA}, ${t.brandA}, 'google_drive', ${`other-${randomUUID()}`}, ${storageKey}, 'image/png', 5, ${"0".repeat(64)}, 'stored', ${JSON.stringify({})}::jsonb)`;
    const fake = fakeDriveUpload();

    const outcome = await uploadArtifactToDrive(depsFor(sql, fake, []), {
      ...requestFor(scope, storageKey, patternBytes(TOTAL)),
      storageObject: { lifecycle: "stored" },
    });
    assert.equal(outcome.status, "failed");
    if (outcome.status !== "failed") return;
    assert.match(outcome.reason, /different bytes/);
    assert.equal((await sessionRow(sql, outcome.sessionId)).status, "failed", "the session is not completed");
    const stored = await sql<{ sha256: string }>`select sha256 from storage_objects where organization_id = ${t.orgA} and brand_id = ${t.brandA} and name = ${storageKey}`;
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.sha256, "0".repeat(64), "the existing object row is unchanged");
  });
}
