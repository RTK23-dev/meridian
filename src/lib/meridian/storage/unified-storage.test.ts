import assert from "node:assert/strict";
import test from "node:test";
import { getGoogleDriveAuthStatus } from "./google-auth.ts";
import { GoogleDriveClient } from "./drive.ts";
import { createGoogleDriveObjectStore } from "./object-store.ts";

test("getGoogleDriveAuthStatus reports NOT_CONFIGURED when environment variables are unset", () => {
  const originalKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const originalClientId = process.env.GOOGLE_CLIENT_ID;
  const originalSecret = process.env.GOOGLE_CLIENT_SECRET;
  const originalRefresh = process.env.GOOGLE_REFRESH_TOKEN;

  delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REFRESH_TOKEN;

  try {
    const status = getGoogleDriveAuthStatus();
    assert.equal(status.configured, false);
    assert.equal(status.type, "none");
    assert.match(status.detail, /not connected/i);
  } finally {
    if (originalKey) process.env.GOOGLE_SERVICE_ACCOUNT_KEY = originalKey;
    if (originalClientId) process.env.GOOGLE_CLIENT_ID = originalClientId;
    if (originalSecret) process.env.GOOGLE_CLIENT_SECRET = originalSecret;
    if (originalRefresh) process.env.GOOGLE_REFRESH_TOKEN = originalRefresh;
  }
});

test("GoogleDriveClient health reports NOT_CONFIGURED without credentials", async () => {
  const originalKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const originalClientId = process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  delete process.env.GOOGLE_CLIENT_ID;

  try {
    const client = new GoogleDriveClient();
    const health = await client.health();
    assert.equal(health.status, "NOT_CONFIGURED");
  } finally {
    if (originalKey) process.env.GOOGLE_SERVICE_ACCOUNT_KEY = originalKey;
    if (originalClientId) process.env.GOOGLE_CLIENT_ID = originalClientId;
  }
});

test("createGoogleDriveObjectStore exposes storage operations", () => {
  const store = createGoogleDriveObjectStore();
  assert.equal(store.id, "google_drive");
  assert.equal(typeof store.put, "function");
  assert.equal(typeof store.get, "function");
  assert.equal(typeof store.delete, "function");
});

test("createGoogleDriveObjectStore resolves provider_file_id before calling drive.get", async () => {
  let passedIdToGet = "";
  const fakeDrive = {
    async put(input: any) {
      return {
        fileId: "drive_file_id_12345",
        name: "test.mp4",
        mimeType: input.mimeType,
        size: input.bytes.byteLength,
        checksum: "abc123hash",
      };
    },
    async get(fileId: string) {
      passedIdToGet = fileId;
      return {
        bytes: new Uint8Array([1, 2, 3, 4]),
        mimeType: "video/mp4",
        name: "test.mp4",
      };
    },
    async delete() {},
  } as any;

  const store = createGoogleDriveObjectStore(fakeDrive);
  await store.put({
    organizationId: "org-test",
    brandId: "brand-test",
    key: "creatives/test.mp4",
    mimeType: "video/mp4",
    bytes: new Uint8Array([1, 2, 3, 4]),
  });

  const retrieved = await store.get("org-test", "brand-test", "creatives/test.mp4");
  assert.ok(retrieved);
  assert.equal(passedIdToGet, "drive_file_id_12345");
  assert.notEqual(passedIdToGet, "creatives/test.mp4");
  assert.equal(retrieved.size, 4);
});
