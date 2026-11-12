// Saving a finished file from a coding agent: the signed address, and the handler, on the test database with an in-memory file store.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import type { McpFileStore } from "./files.ts";
import { listFiles } from "./files.ts";
import { acceptMcpUpload, looksLike } from "./serve-upload.server.ts";
import { MAX_UPLOAD_BYTES, uploadLink, uploadToken, verifyUploadToken, type UploadClaims } from "./upload-link.ts";

const SECRET = "s".repeat(40);
const ENV = { MEDIA_LINK_SECRET: SECRET };
const NOW = 1_800_000_000;
const WS = "ws_upload";
const CONNECTOR = "conn_upload";
const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3]);

const claims = (over: Partial<UploadClaims> = {}): UploadClaims => ({ connectorId: CONNECTOR, organizationId: WS, brandId: null, projectId: null, mediaType: "video/mp4", maxBytes: 1024, expires: NOW + 600, ...over });
const tokenOf = (over: Partial<UploadClaims> = {}) => uploadToken(SECRET, claims(over));

describe("the signed upload address", () => {
  it("verifies its own claims, and refuses a changed payload, another secret and an expired address", () => {
    const token = tokenOf();
    const ok = verifyUploadToken(token, SECRET, NOW);
    assert.ok(ok.ok && ok.claims.connectorId === CONNECTOR && ok.claims.maxBytes === 1024);
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims(), maxBytes: MAX_UPLOAD_BYTES, organizationId: "someone_else" })).toString("base64url");
    assert.deepEqual(verifyUploadToken(`${forged}.${sig}`, SECRET, NOW), { ok: false, reason: "bad_signature" });
    assert.deepEqual(verifyUploadToken(token, "x".repeat(40), NOW), { ok: false, reason: "bad_signature" });
    assert.deepEqual(verifyUploadToken(token, SECRET, NOW + 601), { ok: false, reason: "expired" });
    assert.deepEqual(verifyUploadToken("nodot", SECRET, NOW), { ok: false, reason: "malformed" });
    assert.ok(payload);
  });

  it("is made only when there is a secret, expires in 15 minutes, and cannot ask for more than the maximum", () => {
    assert.equal(uploadLink({ origin: "https://m.example", secret: null, nowSeconds: NOW, claims: { connectorId: "c", organizationId: "o", brandId: null, projectId: null, mediaType: "video/mp4" } }), null);
    const link = uploadLink({ origin: "https://m.example/", secret: SECRET, nowSeconds: NOW, claims: { connectorId: "c", organizationId: "o", brandId: null, projectId: null, mediaType: "video/mp4", maxBytes: MAX_UPLOAD_BYTES * 10 } });
    assert.ok(link);
    assert.match(link.url, /^https:\/\/m\.example\/api\/mcp-upload\//);
    const token = link.url.split("/api/mcp-upload/")[1];
    const check = verifyUploadToken(token, SECRET, NOW);
    assert.ok(check.ok && check.claims.maxBytes === MAX_UPLOAD_BYTES && check.claims.expires === NOW + 900);
  });

  it("a download link's signature cannot stand in for an upload address", async () => {
    const { fileLink } = await import("./files.ts");
    const link = fileLink({ origin: "https://m.example", fileId: "abc", nowSeconds: NOW, secret: SECRET });
    assert.ok(link);
    const sig = new URL(link.url).searchParams.get("sig") ?? "";
    assert.equal(verifyUploadToken(`${Buffer.from(JSON.stringify(claims())).toString("base64url")}.${Buffer.from(sig, "hex").toString("base64url")}`, SECRET, NOW).ok, false);
  });
});

describe("the file check", () => {
  it("knows each type by its first bytes and refuses the wrong file", () => {
    assert.equal(looksLike("video/mp4", MP4), true);
    assert.equal(looksLike("video/mp4", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), false);
    assert.equal(looksLike("image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])), true);
    assert.equal(looksLike("image/jpeg", new Uint8Array([0xff, 0xd8, 0xff])), true);
    assert.equal(looksLike("audio/wav", new TextEncoder().encode("RIFF....WAVEfmt ")), true);
    assert.equal(looksLike("text/html", new TextEncoder().encode("<html>")), false);
  });
});

describe("the upload handler", () => {
  let db: TestDatabase;
  const stored: Array<{ key: string; bytes: Uint8Array }> = [];
  const store: McpFileStore = {
    async ready() { return { status: "ready" }; },
    async put(input) { stored.push({ key: input.key, bytes: input.bytes }); return { storageObjectId: null }; },
    async get() { return null; },
  };
  const deps = () => ({ getSql: async () => db.sql, env: ENV, store: async () => store, nowSeconds: NOW });
  const post = (token: string, body: Uint8Array | null, headers: Record<string, string> = { "content-type": "video/mp4" }, method = "POST") =>
    acceptMcpUpload(new Request(`https://m.example/api/mcp-upload/${token}`, { method, headers, body: body as never }), token, deps());

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, WS, "brand_upload");
    await db.sql`insert into "user" (id, name, email, "emailVerified") values ('u_up', 'u', 'u_up@x.test', true) on conflict do nothing`;
    await db.sql`insert into mcp_connectors (id, organization_id, created_by, name, token_hash, token_hint) values (${CONNECTOR}, ${WS}, 'u_up', 'up', ${"a".repeat(64)}, 'abcd')`;
    await db.sql`insert into mcp_projects (id, organization_id, brand_id, connector_id, title, mode) values ('proj_up', ${WS}, 'brand_upload', ${CONNECTOR}, 't', 'guided')`;
  });
  after(async () => { await db.close(); });

  it("stores a real MP4, records it as a video file of the workspace, and answers with its id", async () => {
    const res = await post(tokenOf(), MP4);
    assert.equal(res.status, 201);
    const body = (await res.json()) as { fileId: string; bytes: number };
    assert.equal(body.bytes, MP4.byteLength);
    assert.equal(stored.at(-1)?.bytes.byteLength, MP4.byteLength);
    const files = await listFiles(db.sql, { organizationId: WS });
    assert.ok(files.some((file) => file.id === body.fileId && file.kind === "video" && file.mediaType === "video/mp4"));
  });

  it("refuses a bad or expired address, a wrong type, a wrong file, an empty file and a file past the signed size", async () => {
    assert.equal((await post("junk", MP4)).status, 403);
    assert.equal((await post(tokenOf({ expires: NOW - 1 }), MP4)).status, 410);
    assert.equal((await post(tokenOf(), MP4, { "content-type": "image/png" })).status, 415);
    assert.equal((await post(tokenOf(), new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9]))).status, 422);
    assert.equal((await post(tokenOf(), new Uint8Array(0))).status, 400);
    assert.equal((await post(tokenOf({ maxBytes: 8 }), MP4)).status, 413);
  });

  it("links a file to the video project the address names, and refuses any other method", async () => {
    const res = await post(tokenOf({ projectId: "proj_up", brandId: "brand_upload" }), MP4);
    assert.equal(res.status, 201);
    const files = await listFiles(db.sql, { organizationId: WS, projectId: "proj_up" });
    assert.equal(files.length, 1);
    assert.equal((await acceptMcpUpload(new Request("https://m.example/x", { method: "GET" }), tokenOf(), deps())).status, 405);
  });

  it("stops working when the connector is revoked, even before the address expires", async () => {
    const before = stored.length;
    await db.sql`update mcp_connectors set revoked_at = now() where id = ${CONNECTOR}`;
    assert.equal((await post(tokenOf(), MP4)).status, 403);
    assert.equal(stored.length, before, "nothing was stored");
    await db.sql`update mcp_connectors set revoked_at = null where id = ${CONNECTOR}`;
  });

  it("refuses a project that is not in the workspace, and an address for another workspace's connector", async () => {
    assert.equal((await post(tokenOf({ projectId: "proj_not_here" }), MP4)).status, 404);
    assert.equal((await post(tokenOf({ organizationId: "some_other_workspace" }), MP4)).status, 403);
  });

  it("is not set up without MEDIA_LINK_SECRET", async () => {
    const res = await acceptMcpUpload(new Request("https://m.example/x", { method: "POST", headers: { "content-type": "video/mp4" }, body: MP4 as never }), tokenOf(), { ...deps(), env: {} });
    assert.equal(res.status, 503);
  });
});
