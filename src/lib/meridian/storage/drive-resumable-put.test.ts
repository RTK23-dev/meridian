import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { getSql } from "../../db.ts";
import { createSqlArtifactUploadStore } from "./artifact-upload-sql.ts";
import { GoogleDriveClient } from "./drive.ts";
import { fakeDriveUpload, patternBytes } from "./fake-drive-upload.ts";

// GoogleDriveClient.put for a file over 5 MB goes through the resumable path. Drive is stubbed (no network), and the session
// is recorded in Postgres through the same connection the application uses.

const ENV_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GOOGLE_SERVICE_ACCOUNT_KEY"] as const;
const CHUNK = 256 * 1024;

async function withDriveEnv(fn: () => Promise<void>) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.GOOGLE_CLIENT_ID = "client-test";
  process.env.GOOGLE_CLIENT_SECRET = "secret-test";
  process.env.GOOGLE_REFRESH_TOKEN = "refresh-test";
  delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  try {
    await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** Routes Drive folder and token calls to small stubs, and upload calls to the fake Drive. */
function stubGoogle(fake: ReturnType<typeof fakeDriveUpload>) {
  const original = globalThis.fetch;
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "token-test", expires_in: 3600 });
    if (url.startsWith("https://www.googleapis.com/drive/v3/files") && (!init?.method || init.method === "GET")) {
      const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
      // Every folder resolves to one folder. The existing-object check finds nothing, so this is a new upload.
      if (q.includes("application/vnd.google-apps.folder")) return json({ files: [{ id: "folder-1", createdTime: "2026-10-10T00:00:00Z" }] });
      return json({ files: [] });
    }
    return fake.fetch(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function seedBrand(sql: Awaited<ReturnType<typeof getSql>>) {
  const run = randomUUID();
  const userId = `user-${run}`;
  const orgId = `org-${run}`;
  const brandId = `brand-${run}`;
  await sql`insert into "user" (id, name, email, "emailVerified") values (${userId}, 'Member', ${`${userId}@example.test`}, true)`;
  await sql`insert into organizations (id, name, slug, created_by) values (${orgId}, 'Org', ${`s-${run}`}, ${userId})`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${orgId}, 'Brand', ${userId})`;
  return { orgId, brandId };
}

test("a file over 5 MB is put to Drive in chunks, its session is recorded in Postgres, and put writes no storage row", async () => {
  await withDriveEnv(async () => {
    const sql = await getSql();
    const { orgId, brandId } = await seedBrand(sql);
    const fake = fakeDriveUpload();
    const restore = stubGoogle(fake);
    try {
      const client = new GoogleDriveClient({
        uploadStore: async () => createSqlArtifactUploadStore(sql),
        upload: { chunkBytes: CHUNK, sleep: async () => {} },
      });
      const bytes = patternBytes(5 * 1024 * 1024 + 300 * 1024);
      const path = `production/${randomUUID()}/artifact.png`;
      const meta = await client.put({ organizationId: orgId, brandId, path, mimeType: "image/png", bytes });

      assert.equal(meta.fileId, fake.fileIds()[0]);
      assert.equal(meta.size, bytes.byteLength);
      assert.equal(meta.checksum, createHash("sha256").update(bytes).digest("hex"));
      assert.ok(fake.persistedBytes(fake.sessionUris()[0]!).equals(Buffer.from(bytes)), "Drive holds exactly the bytes");
      assert.equal(fake.chunkRanges()[0], `bytes 0-${CHUNK - 1}/${bytes.byteLength}`);

      const rows = await sql<{ status: string; provider_file_id: string }>`
        select status, provider_file_id from artifact_upload_sessions
        where organization_id = ${orgId} and brand_id = ${brandId} and storage_key = ${path}`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.status, "completed");
      assert.equal(rows[0]!.provider_file_id, meta.fileId);

      // The caller that records the artifact (the finalizer) owns the storage_objects row. put does not write it.
      const objects = await sql<{ n: number }>`select count(*)::int as n from storage_objects
        where organization_id = ${orgId} and brand_id = ${brandId} and name = ${path}`;
      assert.equal(Number(objects[0]!.n), 0);
    } finally {
      restore();
    }
  });
});

test("a put whose upload fails after the retry cap throws a plain error, and the session stays failed in Postgres", async () => {
  await withDriveEnv(async () => {
    const sql = await getSql();
    const { orgId, brandId } = await seedBrand(sql);
    const fake = fakeDriveUpload();
    fake.control.failAllWith = 503;
    const restore = stubGoogle(fake);
    try {
      const client = new GoogleDriveClient({
        uploadStore: async () => createSqlArtifactUploadStore(sql),
        upload: { chunkBytes: CHUNK, maxFailures: 2, sleep: async () => {} },
      });
      const path = `production/${randomUUID()}/artifact.png`;
      await assert.rejects(
        client.put({ organizationId: orgId, brandId, path, mimeType: "image/png", bytes: patternBytes(5 * 1024 * 1024 + 1) }),
        (err: unknown) => err instanceof Error && /recorded as failed in Postgres/.test(err.message) && /HTTP 503/.test(err.message),
      );
      const rows = await sql<{ status: string; attempts: number }>`
        select status, attempts from artifact_upload_sessions
        where organization_id = ${orgId} and brand_id = ${brandId} and storage_key = ${path}`;
      assert.equal(rows[0]?.status, "failed");
      assert.equal(Number(rows[0]?.attempts), 2);
    } finally {
      restore();
    }
  });
});
