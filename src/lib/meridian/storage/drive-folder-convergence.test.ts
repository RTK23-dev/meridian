import assert from "node:assert/strict";
import test from "node:test";
import { GoogleDriveClient, pickEarliest } from "./drive.ts";

// An in-memory Drive stands in for the API. The token endpoint is stubbed too, so no network call is made.

type Folder = { id: string; name: string; parent: string | null; createdTime: string };

function fakeDrive(options: { seed?: Folder[]; duplicateDuringCreate?: Folder } = {}) {
  const folders: Folder[] = [...(options.seed ?? [])];
  const creates: string[] = [];
  let clock = 0;
  const epoch = Date.parse("2026-10-10T07:00:00Z");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "token-test", expires_in: 3600 }), { status: 200 });
    }
    if (url.startsWith("https://www.googleapis.com/drive/v3/files") && (!init?.method || init.method === "GET")) {
      const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\'/g, "'");
      const parent = /'([^']+)' in parents/.exec(q)?.[1] ?? null;
      const matches = folders.filter((f) => f.name === name && (parent === null || f.parent === parent));
      return new Response(JSON.stringify({ files: matches.map((f) => ({ id: f.id, name: f.name, createdTime: f.createdTime })) }), { status: 200 });
    }
    if (url === "https://www.googleapis.com/drive/v3/files" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { name: string; parents?: string[] };
      creates.push(body.name);
      clock += 1;
      const created: Folder = {
        id: `folder-${creates.length}-${clock}`,
        name: body.name,
        parent: body.parents?.[0] ?? null,
        createdTime: new Date(epoch + clock * 1000).toISOString(),
      };
      folders.push(created);
      if (options.duplicateDuringCreate) {
        // Another process created the same folder at the same moment, earlier than ours.
        folders.push(options.duplicateDuringCreate);
      }
      return new Response(JSON.stringify({ id: created.id }), { status: 200 });
    }
    return new Response("not stubbed", { status: 500 });
  }) as typeof fetch;
  const restore = () => {
    globalThis.fetch = originalFetch;
  };
  return { folders, creates, restore };
}

async function withDriveEnv(fn: () => Promise<void>) {
  const keys = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GOOGLE_SERVICE_ACCOUNT_KEY"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.GOOGLE_CLIENT_ID = "client-test";
  process.env.GOOGLE_CLIENT_SECRET = "secret-test";
  process.env.GOOGLE_REFRESH_TOKEN = "refresh-test";
  delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  try {
    await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("concurrent requests for one folder share a single lookup and create it once", () =>
  withDriveEnv(async () => {
    const drive = fakeDrive();
    try {
      const client = new GoogleDriveClient();
      const [first, second] = await Promise.all([client.findOrCreateFolder("tenants"), client.findOrCreateFolder("tenants")]);
      assert.equal(first, second);
      assert.equal(drive.creates.length, 1, "the folder was created once");
    } finally {
      drive.restore();
    }
  }));

test("when several folders already share a name, every caller settles on the earliest-created one", () =>
  withDriveEnv(async () => {
    const seed: Folder[] = [
      { id: "late", name: "brands", parent: "parent-1", createdTime: "2026-10-10T00:00:05Z" },
      { id: "early", name: "brands", parent: "parent-1", createdTime: "2026-10-10T00:00:01Z" },
    ];
    const drive = fakeDrive({ seed });
    try {
      const id = await new GoogleDriveClient().findOrCreateFolder("brands", "parent-1");
      assert.equal(id, "early");
      assert.equal(drive.creates.length, 0, "no new folder is created when one exists");
    } finally {
      drive.restore();
    }
  }));

test("a duplicate created by another process during our create is resolved to the earliest one", () =>
  withDriveEnv(async () => {
    const drive = fakeDrive({
      duplicateDuringCreate: { id: "other-process", name: "brands", parent: "parent-2", createdTime: "2026-10-10T06:59:00Z" },
    });
    try {
      const id = await new GoogleDriveClient().findOrCreateFolder("brands", "parent-2");
      assert.equal(id, "other-process", "both processes settle on the same folder");
    } finally {
      drive.restore();
    }
  }));

test("pickEarliest is deterministic on equal times, so every process chooses the same folder", () => {
  assert.equal(pickEarliest([{ id: "b", createdTime: "t" }, { id: "a", createdTime: "t" }]), "a");
});
