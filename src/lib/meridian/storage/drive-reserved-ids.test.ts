// Small Drive writes with a reserved file id, against an in-memory Drive that answers 409 for a taken id, as Drive does. The token
// endpoint is stubbed and global fetch is replaced, so no request leaves the process. The Drive search is made to lag (it finds no file),
// which is the case the reservation exists for: a reconciliation lookup that has not caught up with a create.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { GoogleDriveClient } from "./drive.ts";
import { createMemoryDriveReservationStore, type DriveReservationStore } from "./drive-reservation.ts";
import { forgetStorageHome, storageHomeOf } from "./meridian-store.ts";

const ENV_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GOOGLE_SERVICE_ACCOUNT_KEY"];
const ORG = "org_fixture";
const BRAND = "brand_fixture";
const PATH = "production/manifest.json";
const BYTES = new TextEncoder().encode('{"ok":true}');
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type DriveFile = { id: string; name: string; mimeType: string; bytes: Uint8Array; appProperties: Record<string, string> };

let savedEnv: Record<string, string | undefined>;
let files: Map<string, DriveFile>;
let creates: string[];
let generated: number;
let loseNextCreateResponse: boolean;

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

/** Reads the metadata and media parts of a multipart/related body the way Drive does. */
function parseMultipart(body: Uint8Array, contentType: string): { metadata: Record<string, unknown>; media: Uint8Array } {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1] ?? "";
  const parts = latin1(body).split(`\r\n--${boundary}`);
  const metaText = parts[1]!.slice(parts[1]!.indexOf("\r\n\r\n") + 4);
  const mediaText = parts[2]!.slice(parts[2]!.indexOf("\r\n\r\n") + 4);
  return { metadata: JSON.parse(metaText) as Record<string, unknown>, media: new Uint8Array(Buffer.from(mediaText, "latin1")) };
}

function fakeDrive(input: string | URL | Request, init?: RequestInit): Response {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "token-test", expires_in: 3600 });
  if (url.startsWith("https://www.googleapis.com/drive/v3/about")) return Response.json({ user: {} });
  if (url.startsWith("https://www.googleapis.com/drive/v3/files/generateIds")) {
    generated += 1;
    return Response.json({ ids: [`reservedFixtureId${generated}`] });
  }
  if (method === "POST" && url.startsWith("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart")) {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const { metadata, media } = parseMultipart(init!.body as Uint8Array, headers["Content-Type"]!);
    const id = String(metadata.id ?? "");
    if (!id) return new Response("no id", { status: 400 });
    if (files.has(id)) return Response.json({ error: { code: 409, message: "A file already exists with the provided ID." } }, { status: 409 });
    creates.push(id);
    files.set(id, { id, name: String(metadata.name), mimeType: "application/json", bytes: media, appProperties: metadata.appProperties as Record<string, string> });
    if (loseNextCreateResponse) {
      loseNextCreateResponse = false;
      throw new TypeError("fetch failed: the connection closed before the response");
    }
    return Response.json({ id, name: metadata.name, mimeType: "application/json", size: String(media.byteLength) });
  }
  if (method === "GET" && url.startsWith("https://www.googleapis.com/drive/v3/files?")) {
    // Folder lookups find one folder; the file search lags and finds nothing.
    if (url.includes(encodeURIComponent("application/vnd.google-apps.folder"))) {
      return Response.json({ files: [{ id: "folder_fixture", name: "fixture", createdTime: "2026-10-10T00:00:00Z" }] });
    }
    return Response.json({ files: [] });
  }
  const byId = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^?/]+)\?(.*)$/.exec(url);
  if (method === "GET" && byId) {
    const file = files.get(byId[1]!);
    if (!file) return new Response("not found", { status: 404 });
    if (byId[2] === "alt=media") return new Response(Buffer.from(file.bytes));
    return Response.json({ id: file.id, name: file.name, mimeType: file.mimeType, size: String(file.bytes.byteLength), appProperties: file.appProperties, trashed: false });
  }
  return new Response(`not stubbed: ${method} ${url}`, { status: 500 });
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.GOOGLE_CLIENT_ID = "client-test";
  process.env.GOOGLE_CLIENT_SECRET = "secret-test";
  process.env.GOOGLE_REFRESH_TOKEN = "refresh-test";
  delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  files = new Map();
  creates = [];
  generated = 0;
  loseNextCreateResponse = false;
  mock.method(globalThis, "fetch", (async (input: string | URL | Request, init?: RequestInit) => fakeDrive(input, init)) as typeof fetch);
});

afterEach(() => {
  mock.restoreAll();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** A client as production builds it (no injected fetch), with the reservation table in memory. */
function client(reservations: DriveReservationStore): GoogleDriveClient {
  return new GoogleDriveClient({ reservations: async () => reservations });
}

const put = (drive: GoogleDriveClient, bytes = BYTES) =>
  drive.put({ organizationId: ORG, brandId: BRAND, path: PATH, mimeType: "application/json", bytes });

describe("small Drive writes under a reserved file id", () => {
  test("a put through the production default sends one create, with the reserved id, and records the reservation", async () => {
    const reservations = createMemoryDriveReservationStore();
    const stored = await put(client(reservations));
    assert.deepEqual(creates, ["reservedFixtureId1"]);
    assert.equal(stored.fileId, "reservedFixtureId1");
    assert.equal(stored.checksum, sha(BYTES));
    assert.equal(reservations.size(), 1);
  });

  test("two concurrent writers of the same small file create exactly one Drive file, and both get its id", async () => {
    const reservations = createMemoryDriveReservationStore();
    const [first, second] = await Promise.all([put(client(reservations)), put(client(reservations))]);
    assert.equal(files.size, 1, "Drive holds one file");
    assert.equal(creates.length, 1, "one create was accepted; the other was refused as a taken id");
    assert.equal(first.fileId, second.fileId);
    assert.equal(reservations.size(), 1);
  });

  test("a create whose response is lost, then retried, leaves one file: the retry reuses the id and Drive's 409 is confirmed", async () => {
    const reservations = createMemoryDriveReservationStore();
    loseNextCreateResponse = true;
    await assert.rejects(put(client(reservations)), /connection closed/);
    assert.equal(files.size, 1, "Drive took the first create");
    const retried = await put(client(reservations));
    assert.equal(files.size, 1, "the retry created nothing more");
    assert.equal(generated, 1, "the retry did not ask Drive for a new id");
    assert.equal(retried.fileId, "reservedFixtureId1");
  });

  test("a 409 whose existing file has a different hash is an error, not a success", async () => {
    const reservations = createMemoryDriveReservationStore();
    const storageKeyHash = createHash("sha256").update(PATH).digest("hex");
    await reservations.reserve({ organizationId: ORG, scope: BRAND, storageKeyHash, sha256: sha(BYTES) }, "takenFixtureId01");
    const other = new TextEncoder().encode('{"ok":false}');
    files.set("takenFixtureId01", {
      id: "takenFixtureId01",
      name: "manifest.json",
      mimeType: "application/json",
      bytes: other,
      appProperties: { meridian_storage_key_hash: storageKeyHash, sha256: sha(other), organizationId: ORG, brandId: BRAND },
    });
    await assert.rejects(put(client(reservations)), /different tenant ownership or content/);
    assert.deepEqual(creates, [], "nothing was created");
  });

  test("a 409 whose existing file claims the same hash but holds other bytes fails verification", async () => {
    const reservations = createMemoryDriveReservationStore();
    const storageKeyHash = createHash("sha256").update(PATH).digest("hex");
    await reservations.reserve({ organizationId: ORG, scope: BRAND, storageKeyHash, sha256: sha(BYTES) }, "takenFixtureId02");
    files.set("takenFixtureId02", {
      id: "takenFixtureId02",
      name: "manifest.json",
      mimeType: "application/json",
      bytes: new TextEncoder().encode("tampered"),
      appProperties: { meridian_storage_key_hash: storageKeyHash, sha256: sha(BYTES), organizationId: ORG, brandId: BRAND },
    });
    await assert.rejects(put(client(reservations)), /failed idempotent upload verification/);
  });

  test("a generateIds answer that is not a Drive id is refused before any create", async () => {
    mock.restoreAll();
    mock.method(globalThis, "fetch", (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes("generateIds") ? Response.json({ ids: ["../../escape"] }) : fakeDrive(input, init)) as typeof fetch);
    await assert.rejects(put(client(createMemoryDriveReservationStore())), /no usable file id/);
    assert.deepEqual(creates, []);
  });
});

describe("where new files go", () => {
  test("with Drive set up and answering, new files go to Drive (writing to Drive is on)", async () => {
    forgetStorageHome("org_home_fixture");
    const home = await storageHomeOf("org_home_fixture");
    forgetStorageHome("org_home_fixture");
    assert.equal(home.kind, "drive");
  });
});
