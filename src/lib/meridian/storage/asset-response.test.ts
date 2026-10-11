import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { createPoolSql, getSql, type Sql } from "../../db.ts";
import { createRateLimit } from "../security/limits.ts";
import { serveStoredAsset, type ArtifactFileReader } from "./asset-response.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(24).fill(0)]);
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, ...new Array<number>(20).fill(0)]);
const HTML = new TextEncoder().encode("<!doctype html><html><body>stored by mistake</body></html>");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

type Backend = { name: string; sql: Sql; close: () => Promise<void> };

/** The embedded database always runs. The PostgreSQL branch runs when MERIDIAN_PG_TEST_URL names a migrated database. */
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

const closers: Array<() => Promise<void>> = [];
after(async () => {
  for (const close of closers) await close();
});

type Workspace = { userId: string; strangerId: string; orgId: string; otherOrgId: string; brandId: string; otherBrandId: string };

/** One member of one workspace, a second workspace the member does not belong to, and a user with no membership at all. */
async function seedWorkspace(sql: Sql): Promise<Workspace> {
  const run = randomUUID();
  const ws: Workspace = {
    userId: `user-${run}`,
    strangerId: `stranger-${run}`,
    orgId: `org-${run}`,
    otherOrgId: `org-other-${run}`,
    brandId: `brand-${run}`,
    otherBrandId: `brand-other-${run}`,
  };
  await sql`insert into "user" (id, name, email, "emailVerified") values (${ws.userId}, 'Member', ${`${ws.userId}@example.test`}, true)`;
  await sql`insert into "user" (id, name, email, "emailVerified") values (${ws.strangerId}, 'Stranger', ${`${ws.strangerId}@example.test`}, true)`;
  await sql`insert into organizations (id, name, slug, created_by) values (${ws.orgId}, 'Org', ${`slug-${run}`}, ${ws.userId})`;
  await sql`insert into organizations (id, name, slug, created_by) values (${ws.otherOrgId}, 'Other', ${`other-${run}`}, ${ws.strangerId})`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${ws.brandId}, ${ws.orgId}, 'Brand', ${ws.userId})`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${ws.otherBrandId}, ${ws.otherOrgId}, 'Other brand', ${ws.strangerId})`;
  await sql`insert into memberships (id, organization_id, user_id, role) values (${`m-${run}`}, ${ws.orgId}, ${ws.userId}, 'member')`;
  await sql`insert into user_settings (user_id, active_organization_id) values (${ws.userId}, ${ws.orgId})`;
  return ws;
}

/** A stored asset with its bytes in asset_blobs. Each storage key is unique, because asset_blobs keys are global. */
async function addBlobAsset(sql: Sql, ws: Workspace, input: { assetId?: string; storageKey?: string; mimeType?: string; bytes: Uint8Array; orgId?: string; brandId?: string; status?: string }) {
  const assetId = input.assetId ?? `asset-${randomUUID()}`;
  const storageKey = input.storageKey ?? `studio/${randomUUID()}/clip`;
  const orgId = input.orgId ?? ws.orgId;
  const brandId = input.brandId ?? ws.brandId;
  const mimeType = input.mimeType ?? "image/png";
  await sql`insert into assets (id, organization_id, brand_id, storage_key, content_hash, mime_type, source, status)
    values (${assetId}, ${orgId}, ${brandId}, ${storageKey}, ${sha256(input.bytes)}, ${mimeType}, 'studio', ${input.status ?? "stored"})`;
  await addBlob(sql, { storageKey, orgId, brandId, mimeType, bytes: input.bytes });
  return { assetId, storageKey };
}

async function addBlob(sql: Sql, input: { storageKey: string; orgId: string; brandId: string; mimeType: string; bytes: Uint8Array; checksum?: string; byteSize?: number }) {
  await sql`insert into asset_blobs (storage_key, organization_id, brand_id, body, mime_type, checksum, byte_size, version, lifecycle, access_token)
    values (${input.storageKey}, ${input.orgId}, ${input.brandId}, ${base64(input.bytes)}, ${input.mimeType},
      ${input.checksum ?? sha256(input.bytes)}, ${input.byteSize ?? input.bytes.byteLength}, 1, 'stored', '')`;
}

type ServeOptions = {
  path?: string;
  headers?: Record<string, string>;
  userId?: string | null;
  rateLimit?: { allow(key: string, now: number): boolean };
  drive?: ArtifactFileReader;
};

function serveFor(sql: Sql, ws: Workspace, assetId: string, options: ServeOptions = {}) {
  return serveStoredAsset({
    request: new Request(`http://meridian.test${options.path ?? `/api/assets/${assetId}`}`, { headers: options.headers }),
    assetId,
    userId: options.userId === undefined ? ws.userId : options.userId,
    getSql: async () => sql,
    loadArtifactFiles: async () => options.drive ?? (() => { throw new Error("the artifact store must not be read here"); })(),
    rateLimit: options.rateLimit ?? createRateLimit(1000, 60_000),
    logError: () => {},
    now: () => 1_000,
  });
}

test("a signed-out request is refused with 401 before anything is read", async () => {
  const sql = { query: () => { throw new Error("no database access"); } } as unknown as Sql;
  const ws = { userId: "", strangerId: "", orgId: "", otherOrgId: "", brandId: "", otherBrandId: "" };
  const response = await serveFor(sql, ws, "asset-x", { userId: null });
  assert.equal(response.status, 401);
});

for (const backend of await openBackends()) {
  closers.push(backend.close);
  const { name, sql } = backend;

  test(`[${name}] serves a stored image with verified headers`, async () => {
    const ws = await seedWorkspace(sql);
    const { assetId } = await addBlobAsset(sql, ws, { bytes: PNG });
    const response = await serveFor(sql, ws, assetId);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("content-length"), String(PNG.byteLength));
    assert.equal(response.headers.get("etag"), `"${sha256(PNG)}"`);
    assert.equal(response.headers.get("content-disposition"), "inline");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; sandbox");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG);
  });

  test(`[${name}] answers a byte range with 206 and the matching Content-Range`, async () => {
    const ws = await seedWorkspace(sql);
    const { assetId } = await addBlobAsset(sql, ws, { mimeType: "video/mp4", bytes: MP4 });
    const response = await serveFor(sql, ws, assetId, { headers: { range: "bytes=4-7" } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), `bytes 4-7/${MP4.byteLength}`);
    assert.equal(response.headers.get("content-length"), "4");
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), MP4.subarray(4, 8));
  });

  test(`[${name}] answers an unsatisfiable range with 416`, async () => {
    const ws = await seedWorkspace(sql);
    const { assetId } = await addBlobAsset(sql, ws, { mimeType: "video/mp4", bytes: MP4 });
    const response = await serveFor(sql, ws, assetId, { headers: { range: "bytes=9999-" } });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("content-range"), `bytes */${MP4.byteLength}`);
  });

  test(`[${name}] answers a matching If-None-Match with 304 and no body`, async () => {
    const ws = await seedWorkspace(sql);
    const { assetId } = await addBlobAsset(sql, ws, { bytes: PNG });
    const response = await serveFor(sql, ws, assetId, { headers: { "if-none-match": `W/"${sha256(PNG)}"` } });
    assert.equal(response.status, 304);
    assert.equal(response.headers.get("etag"), `"${sha256(PNG)}"`);
    assert.equal(await response.text(), "");
  });

  test(`[${name}] serves the video poster whole, even when a range is asked for`, async () => {
    const ws = await seedWorkspace(sql);
    const { assetId, storageKey } = await addBlobAsset(sql, ws, { mimeType: "video/mp4", bytes: MP4 });
    await addBlob(sql, { storageKey: `${storageKey}.frame.0.png`, orgId: ws.orgId, brandId: ws.brandId, mimeType: "image/png", bytes: PNG });
    const response = await serveFor(sql, ws, assetId, { path: `/api/assets/${assetId}?thumb=1&download=1`, headers: { range: "bytes=0-3" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("content-disposition"), "inline", "a poster is never an attachment");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG);
  });

  test(`[${name}] answers 404 for a poster that was never stored`, async () => {
    const ws = await seedWorkspace(sql);
    const { assetId } = await addBlobAsset(sql, ws, { mimeType: "video/mp4", bytes: MP4 });
    const response = await serveFor(sql, ws, assetId, { path: `/api/assets/${assetId}?thumb=1` });
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "Not found");
  });

  test(`[${name}] names a download from the asset id`, async () => {
    const ws = await seedWorkspace(sql);
    const { assetId } = await addBlobAsset(sql, ws, { mimeType: "video/mp4", bytes: MP4 });
    const response = await serveFor(sql, ws, assetId, { path: `/api/assets/${assetId}?download=1` });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-disposition"), `attachment; filename="${assetId.replace(/[^A-Za-z0-9_-]/g, "")}.mp4"`);
  });

  test(`[${name}] serves an artifact-store file through the Drive reader when no blob exists`, async () => {
    const ws = await seedWorkspace(sql);
    const assetId = `asset-${randomUUID()}`;
    const storageKey = `production/${randomUUID()}/frame.png`;
    const providerFileId = `drive-${randomUUID()}`;
    await sql`insert into assets (id, organization_id, brand_id, storage_key, content_hash, mime_type, source, status)
      values (${assetId}, ${ws.orgId}, ${ws.brandId}, ${storageKey}, ${sha256(PNG)}, 'image/png', 'production', 'stored')`;
    await sql`insert into storage_objects (id, organization_id, brand_id, provider, provider_file_id, name, mime_type, size_bytes, sha256)
      values (${`obj-${randomUUID()}`}, ${ws.orgId}, ${ws.brandId}, 'google_drive', ${providerFileId}, ${storageKey}, 'image/png', ${PNG.byteLength}, ${sha256(PNG)})`;
    const requested: string[] = [];
    const drive: ArtifactFileReader = { get: async (id) => { requested.push(id); return { bytes: PNG }; } };
    const response = await serveFor(sql, ws, assetId, { drive });
    assert.equal(response.status, 200);
    assert.deepEqual(requested, [providerFileId]);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG);
  });

  test(`[${name}] answers 503 with a retry hint when the artifact store fails`, async () => {
    const ws = await seedWorkspace(sql);
    const assetId = `asset-${randomUUID()}`;
    const storageKey = `production/${randomUUID()}/frame.png`;
    await sql`insert into assets (id, organization_id, brand_id, storage_key, content_hash, mime_type, source, status)
      values (${assetId}, ${ws.orgId}, ${ws.brandId}, ${storageKey}, ${sha256(PNG)}, 'image/png', 'production', 'stored')`;
    await sql`insert into storage_objects (id, organization_id, brand_id, provider, provider_file_id, name, mime_type, size_bytes, sha256)
      values (${`obj-${randomUUID()}`}, ${ws.orgId}, ${ws.brandId}, 'google_drive', ${`drive-${randomUUID()}`}, ${storageKey}, 'image/png', ${PNG.byteLength}, ${sha256(PNG)})`;
    const drive: ArtifactFileReader = { get: async () => { throw new Error("drive unavailable"); } };
    const response = await serveFor(sql, ws, assetId, { drive });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "30");
  });

  test(`[${name}] answers the same 404 for another workspace's asset and for a missing asset`, async () => {
    const ws = await seedWorkspace(sql);
    const { assetId: foreignId } = await addBlobAsset(sql, ws, { orgId: ws.otherOrgId, brandId: ws.otherBrandId, bytes: PNG });
    const foreign = await serveFor(sql, ws, foreignId);
    const missing = await serveFor(sql, ws, `asset-missing-${randomUUID()}`);
    assert.equal(foreign.status, 404);
    assert.equal(missing.status, 404);
    assert.equal(await foreign.text(), await missing.text());
    assert.equal(foreign.headers.get("content-type"), missing.headers.get("content-type"));
  });

  test(`[${name}] answers 404 to a user with no workspace membership`, async () => {
    const ws = await seedWorkspace(sql);
    const { assetId } = await addBlobAsset(sql, ws, { bytes: PNG });
    const response = await serveFor(sql, ws, assetId, { userId: ws.strangerId });
    assert.equal(response.status, 404);
  });

  test(`[${name}] hides an unavailable asset and an asset whose brand was deleted`, async () => {
    const ws = await seedWorkspace(sql);
    const { assetId: unavailable } = await addBlobAsset(sql, ws, { bytes: PNG, status: "unavailable" });
    assert.equal((await serveFor(sql, ws, unavailable)).status, 404);
    const { assetId: deletedBrandAsset } = await addBlobAsset(sql, ws, { bytes: PNG });
    await sql`update brands set deleted_at = now() where id = ${ws.brandId}`;
    assert.equal((await serveFor(sql, ws, deletedBrandAsset)).status, 404);
  });

  test(`[${name}] refuses stored bytes that do not match the recorded checksum`, async () => {
    const ws = await seedWorkspace(sql);
    const storageKey = `studio/${randomUUID()}/tampered`;
    const { assetId } = await addBlobAsset(sql, ws, { storageKey, bytes: PNG });
    await sql`update asset_blobs set checksum = ${"0".repeat(64)} where storage_key = ${storageKey}`;
    const response = await serveFor(sql, ws, assetId);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "Asset unavailable");
  });

  test(`[${name}] never serves stored HTML as media`, async () => {
    const ws = await seedWorkspace(sql);
    const { assetId } = await addBlobAsset(sql, ws, { mimeType: "image/png", bytes: HTML });
    const response = await serveFor(sql, ws, assetId);
    assert.equal(response.status, 404);
  });

  test(`[${name}] answers 429 with a retry hint once the user passes the limit`, async () => {
    const ws = await seedWorkspace(sql);
    const { assetId } = await addBlobAsset(sql, ws, { bytes: PNG });
    const rateLimit = createRateLimit(1, 60_000);
    assert.equal((await serveFor(sql, ws, assetId, { rateLimit })).status, 200);
    const limited = await serveFor(sql, ws, assetId, { rateLimit });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
  });
}
