import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { getSql, type Sql } from "../../db.ts";
import { GoogleDriveClient } from "./drive.ts";
import { recordDriveObject, type DriveObjectRecord } from "./drive-object-record.ts";

// A file written to Drive with storageRecord has one storage_objects row, recorded after Drive accepted the bytes. A failed
// Drive write leaves no row. Drive is stubbed (no network). Postgres is the real database the application uses.

const ENV_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GOOGLE_SERVICE_ACCOUNT_KEY"] as const;

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

type StoredFile = { id: string; name: string; bytes: Uint8Array; mimeType: string; appProperties: Record<string, string> };

/**
 * A small Drive: token, folders, the existing-object lookup, multipart upload, and download. `failUploads` makes every upload
 * answer 500 and store nothing, as a Drive outage would.
 */
function stubDrive(options: { failUploads?: boolean } = {}) {
  const files = new Map<string, StoredFile>();
  const uploads: string[] = [];
  const original = globalThis.fetch;
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "token-test", expires_in: 3600 });
    if (url.startsWith("https://www.googleapis.com/drive/v3/files?") && method === "GET") {
      const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
      if (q.includes("application/vnd.google-apps.folder")) return json({ files: [{ id: "folder-1", createdTime: "2026-10-10T00:00:00Z" }] });
      const hash = /value='([0-9a-f]{64})'/.exec(q)?.[1];
      const matches = [...files.values()].filter((f) => hash && f.appProperties.meridian_storage_key_hash === hash);
      return json({
        files: matches.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: String(f.bytes.byteLength), appProperties: f.appProperties })),
      });
    }
    if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files") && method === "POST") {
      uploads.push(url);
      if (options.failUploads) return new Response("backend unavailable", { status: 500 });
      const body = Buffer.from(init!.body as Uint8Array);
      const text = body.toString("latin1");
      const metaStart = text.indexOf('{"name"');
      const metaEnd = text.indexOf("\r\n--", metaStart);
      const meta = JSON.parse(text.slice(metaStart, metaEnd)) as { name: string; appProperties: Record<string, string> };
      const mimeType = /Content-Type: ([^\r\n]+)\r\n\r\n/.exec(text.slice(metaEnd))?.[1] ?? "application/octet-stream";
      const mediaStart = text.indexOf("\r\n\r\n", metaEnd + 4) + 4;
      const media = Uint8Array.from(body.subarray(mediaStart, body.lastIndexOf("\r\n--")));
      const id = `file-${randomUUID()}`;
      files.set(id, { id, name: meta.name, bytes: media, mimeType, appProperties: meta.appProperties });
      return json({ id, name: meta.name, mimeType, size: String(media.byteLength) });
    }
    const fileId = /\/drive\/v3\/files\/([^?]+)/.exec(url)?.[1];
    if (fileId && method === "GET") {
      const file = files.get(fileId);
      if (!file) return new Response("not found", { status: 404 });
      if (url.includes("alt=media")) return new Response(Buffer.from(file.bytes), { status: 200 });
      return json({ name: file.name, mimeType: file.mimeType });
    }
    return new Response(`unexpected ${method} ${url}`, { status: 599 });
  }) as typeof fetch;
  return { files, uploads, restore: () => (globalThis.fetch = original) };
}

async function seedBrand(sql: Sql) {
  const run = randomUUID();
  const userId = `user-${run}`;
  const orgId = `org-${run}`;
  const brandId = `brand-${run}`;
  await sql`insert into "user" (id, name, email, "emailVerified") values (${userId}, 'Member', ${`${userId}@example.test`}, true)`;
  await sql`insert into organizations (id, name, slug, created_by) values (${orgId}, 'Org', ${`s-${run}`}, ${userId})`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${orgId}, 'Brand', ${userId})`;
  return { orgId, brandId };
}

async function rowsFor(sql: Sql, orgId: string, brandId: string, key: string) {
  return sql<{ id: string; provider: string; provider_file_id: string; sha256: string; size_bytes: string | number; mime_type: string; lifecycle: string; created_at: unknown; name: string }>`
    select id, provider, provider_file_id, sha256, size_bytes, mime_type, lifecycle, created_at, name from storage_objects
    where organization_id = ${orgId} and brand_id = ${brandId} and name = ${key}`;
}

const MANIFEST = Buffer.from(JSON.stringify({ jobId: "prod_mc_test", title: "Manifest" }, null, 2), "utf8");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("a file written to Drive with storageRecord has exactly one storage_objects row, with its key, bytes, sha256 and Drive file id", async () => {
  await withDriveEnv(async () => {
    const sql = await getSql();
    const { orgId, brandId } = await seedBrand(sql);
    const drive = stubDrive();
    try {
      const path = `production/inputs/prod_mc_${randomUUID()}/manifest.json`;
      const client = new GoogleDriveClient({ recordObject: (record) => recordDriveObject(sql, record).then(() => undefined) });
      const meta = await client.put({ organizationId: orgId, brandId, path, mimeType: "application/json", bytes: MANIFEST, storageRecord: { lifecycle: "stored" } });

      const rows = await rowsFor(sql, orgId, brandId, path);
      assert.equal(rows.length, 1, "one row for the file");
      const [row] = rows;
      assert.equal(row!.provider, "google_drive");
      assert.equal(row!.provider_file_id, meta.fileId, "the row holds Drive's file id");
      assert.equal(row!.sha256, sha(MANIFEST));
      assert.equal(Number(row!.size_bytes), MANIFEST.byteLength);
      assert.equal(row!.mime_type, "application/json");
      assert.equal(row!.lifecycle, "stored");
      assert.ok(row!.created_at, "the row records when it was created");
      assert.equal(drive.uploads.length, 1);
    } finally {
      drive.restore();
    }
  });
});

test("writing the same file again keeps one row, and the Drive file it already had", async () => {
  await withDriveEnv(async () => {
    const sql = await getSql();
    const { orgId, brandId } = await seedBrand(sql);
    const drive = stubDrive();
    try {
      const path = `production/inputs/prod_mc_${randomUUID()}/manifest.json`;
      const client = new GoogleDriveClient({ recordObject: (record) => recordDriveObject(sql, record).then(() => undefined) });
      const first = await client.put({ organizationId: orgId, brandId, path, mimeType: "application/json", bytes: MANIFEST, storageRecord: { lifecycle: "stored" } });
      const second = await client.put({ organizationId: orgId, brandId, path, mimeType: "application/json", bytes: MANIFEST, storageRecord: { lifecycle: "stored" } });
      assert.equal(second.fileId, first.fileId, "Drive returns the existing file");
      assert.equal(drive.uploads.length, 1, "no second Drive object is created");
      assert.equal((await rowsFor(sql, orgId, brandId, path)).length, 1, "and no second row");
    } finally {
      drive.restore();
    }
  });
});

test("a put without storageRecord writes no row: the caller that owns the record writes it", async () => {
  await withDriveEnv(async () => {
    const sql = await getSql();
    const { orgId, brandId } = await seedBrand(sql);
    const drive = stubDrive();
    try {
      const path = `production/inputs/prod_mc_${randomUUID()}/manifest.json`;
      await new GoogleDriveClient().put({ organizationId: orgId, brandId, path, mimeType: "application/json", bytes: MANIFEST });
      assert.equal((await rowsFor(sql, orgId, brandId, path)).length, 0);
    } finally {
      drive.restore();
    }
  });
});

test("a failed Drive write leaves no row pointing at nothing", async () => {
  await withDriveEnv(async () => {
    const sql = await getSql();
    const { orgId, brandId } = await seedBrand(sql);
    const drive = stubDrive({ failUploads: true });
    try {
      const path = `production/inputs/prod_mc_${randomUUID()}/manifest.json`;
      const recorded: DriveObjectRecord[] = [];
      const client = new GoogleDriveClient({ recordObject: async (record) => void recorded.push(record) });
      await assert.rejects(
        client.put({ organizationId: orgId, brandId, path, mimeType: "application/json", bytes: MANIFEST, storageRecord: { lifecycle: "stored" } }),
        /HTTP 500|upload failed/i,
      );
      assert.equal(recorded.length, 0, "the record is not written when Drive refused the bytes");
      assert.equal((await rowsFor(sql, orgId, brandId, path)).length, 0);
    } finally {
      drive.restore();
    }
  });
});

test("when Drive accepted the file but its row could not be saved, the caller is told, and a retry records the row once", async () => {
  await withDriveEnv(async () => {
    const sql = await getSql();
    const { orgId, brandId } = await seedBrand(sql);
    const drive = stubDrive();
    try {
      const path = `production/inputs/prod_mc_${randomUUID()}/manifest.json`;
      const failing = new GoogleDriveClient({
        recordObject: async () => {
          throw new Error("connection reset");
        },
      });
      await assert.rejects(
        failing.put({ organizationId: orgId, brandId, path, mimeType: "application/json", bytes: MANIFEST, storageRecord: { lifecycle: "stored" } }),
        /accepted the file, but its storage record was not saved/,
      );
      assert.equal((await rowsFor(sql, orgId, brandId, path)).length, 0);

      const working = new GoogleDriveClient({ recordObject: (record) => recordDriveObject(sql, record).then(() => undefined) });
      await working.put({ organizationId: orgId, brandId, path, mimeType: "application/json", bytes: MANIFEST, storageRecord: { lifecycle: "stored" } });
      assert.equal((await rowsFor(sql, orgId, brandId, path)).length, 1);
      assert.equal(drive.uploads.length, 1, "the retry found the Drive file and did not upload it again");
    } finally {
      drive.restore();
    }
  });
});

test("a different file under a key that already has a row is refused, and the existing row is left as it was", async () => {
  await withDriveEnv(async () => {
    const sql = await getSql();
    const { orgId, brandId } = await seedBrand(sql);
    const drive = stubDrive();
    try {
      const path = `production/inputs/prod_mc_${randomUUID()}/manifest.json`;
      await recordDriveObject(sql, {
        organizationId: orgId,
        brandId,
        key: path,
        fileId: "file-earlier",
        mimeType: "application/json",
        sizeBytes: 3,
        sha256: "0".repeat(64),
        lifecycle: "stored",
      });
      const client = new GoogleDriveClient({ recordObject: (record) => recordDriveObject(sql, record).then(() => undefined) });
      await assert.rejects(
        client.put({ organizationId: orgId, brandId, path, mimeType: "application/json", bytes: MANIFEST, storageRecord: { lifecycle: "stored" } }),
        /already exists under this key with a different file/,
      );
      const rows = await rowsFor(sql, orgId, brandId, path);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.provider_file_id, "file-earlier", "the existing row still points at its own file");
    } finally {
      drive.restore();
    }
  });
});
