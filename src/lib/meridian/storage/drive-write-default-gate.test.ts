// The Google Drive writes through their production default: a client built with no fetch, the way production builds it. The token comes
// from the stubbed OAuth endpoint, and the folder and reconciliation lookups are answered by a fixture. Each lookup is a GET, and it is
// not counted. Every other request is a write, and each one is counted, so the test asserts that no write reached the fixture. The
// drive.write gate refuses each write before it sends anything, and the test asserts that refusal.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { GoogleDriveClient } from "./drive.ts";

const GATE_MESSAGE = /off in this build, so nothing was sent/;
const ENV_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GOOGLE_SERVICE_ACCOUNT_KEY"];

let savedEnv: Record<string, string | undefined>;
let writes: string[];
let folderExists: boolean;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.GOOGLE_CLIENT_ID = "client-test";
  process.env.GOOGLE_CLIENT_SECRET = "secret-test";
  process.env.GOOGLE_REFRESH_TOKEN = "refresh-test";
  delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  writes = [];
  folderExists = true;
  mock.method(globalThis, "fetch", (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return Response.json({ access_token: "token-test", expires_in: 3600 });
    }
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push(`${method} ${url}`);
      return new Response("A Drive write reached the network.", { status: 500 });
    }
    // A folder lookup finds the folder when it exists. The reconciliation lookup finds no earlier upload.
    if (url.includes(encodeURIComponent("application/vnd.google-apps.folder"))) {
      return Response.json({ files: folderExists ? [{ id: "folder_fixture", name: "fixture", createdTime: "2026-10-10T00:00:00Z" }] : [] });
    }
    return Response.json({ files: [] });
  }) as typeof fetch);
});

afterEach(() => {
  mock.restoreAll();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("the Drive writes fail closed through their production defaults", () => {
  test("a small file put is refused by the drive.write gate before any write is sent", async () => {
    await assert.rejects(
      new GoogleDriveClient().put({
        organizationId: "org_fixture",
        brandId: "brand_fixture",
        path: "production/manifest.json",
        mimeType: "application/json",
        bytes: new Uint8Array([1, 2, 3]),
      }),
      GATE_MESSAGE,
    );
    assert.deepEqual(writes, [], "no multipart upload is sent");
  });

  test("a delete is refused by the drive.write gate before any write is sent", async () => {
    await assert.rejects(new GoogleDriveClient().delete("file_fixture"), GATE_MESSAGE);
    assert.deepEqual(writes, [], "no delete is sent");
  });

  test("creating a folder that does not exist is refused by the drive.write gate before any write is sent", async () => {
    folderExists = false;
    await assert.rejects(new GoogleDriveClient().findOrCreateFolder("tenants"), GATE_MESSAGE);
    assert.deepEqual(writes, [], "no folder is created");
  });
});
