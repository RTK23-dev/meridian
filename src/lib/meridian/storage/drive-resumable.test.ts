import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_DRIVE_CHUNK_BYTES,
  DRIVE_UPLOAD_ENDPOINT,
  DriveUploadError,
  assertDriveChunkBytes,
  contentRange,
  parsePersistedBytes,
  queryDriveStatus,
  sendDriveChunk,
  startDriveSession,
  type ResumableTransport,
} from "./drive-resumable.ts";

type Seen = { url: string; method: string; headers: Record<string, string>; body: Uint8Array | null };

/** A transport whose fetch answers from a script, so no network call is made. */
function scripted(responses: Array<Response | Error>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body:
        typeof init?.body === "string"
          ? new TextEncoder().encode(init.body)
          : init?.body instanceof Uint8Array
            ? new Uint8Array(init.body)
            : null,
    });
    const next = responses.shift();
    if (!next) throw new Error("no scripted response left");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  const transport: ResumableTransport = { fetch: fetchImpl, accessToken: async () => "token-test" };
  return { transport, seen };
}

test("chunk sizes must be positive multiples of 256 KiB, and the default is 8 MiB", () => {
  assert.equal(DEFAULT_DRIVE_CHUNK_BYTES, 8 * 1024 * 1024);
  assertDriveChunkBytes(256 * 1024);
  assertDriveChunkBytes(DEFAULT_DRIVE_CHUNK_BYTES);
  assert.throws(() => assertDriveChunkBytes(300 * 1024), /multiple of 262144/);
  assert.throws(() => assertDriveChunkBytes(0), /multiple/);
  assert.throws(() => assertDriveChunkBytes(1.5 * 256 * 1024), /multiple/);
});

test("the persisted offset comes from the 308 Range header; no header means nothing persisted", () => {
  assert.equal(parsePersistedBytes(null), 0);
  assert.equal(parsePersistedBytes("bytes=0-99"), 100);
  assert.equal(parsePersistedBytes("bytes=0-262143"), 262144);
  assert.throws(() => parsePersistedBytes("bytes=5-99"), (err: unknown) => err instanceof DriveUploadError && err.retryable);
});

test("Content-Range names the inclusive byte range and the total", () => {
  assert.equal(contentRange(0, 262144, 614400), "bytes 0-262143/614400");
  assert.equal(contentRange(524288, 614400, 614400), "bytes 524288-614399/614400");
});

test("starting a session posts the metadata and returns the Location session URI", async () => {
  const { transport, seen } = scripted([new Response(null, { status: 200, headers: { location: "https://upload.example.test/session/abc" } })]);
  const uri = await startDriveSession(transport, { metadata: { name: "artifact.png" }, mimeType: "image/png", totalBytes: 614400 });
  assert.equal(uri, "https://upload.example.test/session/abc");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.method, "POST");
  assert.equal(seen[0]!.url, `${DRIVE_UPLOAD_ENDPOINT}?uploadType=resumable&fields=id,name,mimeType,size,webViewLink`);
  assert.equal(seen[0]!.headers["x-upload-content-length"], "614400");
  assert.equal(seen[0]!.headers["x-upload-content-type"], "image/png");
  assert.equal(seen[0]!.headers.authorization, "Bearer token-test");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(seen[0]!.body!)), { name: "artifact.png" });
});

test("a session start that Drive rejects is not retried for a 403, and is retried for a 503", async () => {
  await assert.rejects(
    startDriveSession(scripted([new Response("forbidden", { status: 403 })]).transport, { metadata: {}, mimeType: "image/png", totalBytes: 10 }),
    (err: unknown) => err instanceof DriveUploadError && err.status === 403 && err.retryable === false,
  );
  await assert.rejects(
    startDriveSession(scripted([new Response("busy", { status: 503 })]).transport, { metadata: {}, mimeType: "image/png", totalBytes: 10 }),
    (err: unknown) => err instanceof DriveUploadError && err.status === 503 && err.retryable === true,
  );
});

test("a chunk is sent with its exact Content-Range and length, and a 308 reports what Drive persisted", async () => {
  const { transport, seen } = scripted([new Response(null, { status: 308, headers: { range: "bytes=0-262143" } })]);
  const chunk = new Uint8Array(262144).fill(9);
  const status = await sendDriveChunk(transport, { sessionUri: "https://upload.example.test/session/a", totalBytes: 614400, offset: 0, chunk });
  assert.deepEqual(status, { complete: false, persistedBytes: 262144 });
  assert.equal(seen[0]!.method, "PUT");
  assert.equal(seen[0]!.headers["content-range"], "bytes 0-262143/614400");
  assert.equal(seen[0]!.headers["content-length"], "262144");
  assert.equal(seen[0]!.body!.byteLength, 262144);
});

test("the final chunk returns the finished file with its size", async () => {
  const body = JSON.stringify({ id: "drive-file-9", name: "artifact.png", mimeType: "image/png", size: "10", webViewLink: "https://drive.example.test/x" });
  const { transport, seen } = scripted([new Response(body, { status: 200, headers: { "content-type": "application/json" } })]);
  const status = await sendDriveChunk(transport, {
    sessionUri: "https://upload.example.test/session/a",
    totalBytes: 10,
    offset: 4,
    chunk: new Uint8Array(6),
  });
  assert.equal(seen[0]!.headers["content-range"], "bytes 4-9/10");
  assert.deepEqual(status, {
    complete: true,
    file: { id: "drive-file-9", name: "artifact.png", mimeType: "image/png", size: 10, webViewLink: "https://drive.example.test/x" },
  });
});

test("a status query sends bytes */total with no body and reads the persisted offset", async () => {
  const { transport, seen } = scripted([new Response(null, { status: 308, headers: { range: "bytes=0-524287" } })]);
  const status = await queryDriveStatus(transport, { sessionUri: "https://upload.example.test/session/a", totalBytes: 614400 });
  assert.deepEqual(status, { complete: false, persistedBytes: 524288 });
  assert.equal(seen[0]!.headers["content-range"], "bytes */614400");
  assert.equal(seen[0]!.headers["content-length"], "0");
});

test("a status query with no Range header means nothing is persisted yet", async () => {
  const { transport } = scripted([new Response(null, { status: 308 })]);
  const status = await queryDriveStatus(transport, { sessionUri: "https://upload.example.test/session/a", totalBytes: 614400 });
  assert.deepEqual(status, { complete: false, persistedBytes: 0 });
});

test("a dropped connection is retryable, and a session Drive no longer knows (404) is not", async () => {
  await assert.rejects(
    sendDriveChunk(scripted([new TypeError("fetch failed")]).transport, {
      sessionUri: "https://upload.example.test/session/a",
      totalBytes: 10,
      offset: 0,
      chunk: new Uint8Array(10),
    }),
    TypeError,
  );
  await assert.rejects(
    sendDriveChunk(scripted([new Response("gone", { status: 404 })]).transport, {
      sessionUri: "https://upload.example.test/session/a",
      totalBytes: 10,
      offset: 0,
      chunk: new Uint8Array(10),
    }),
    (err: unknown) => err instanceof DriveUploadError && err.status === 404 && err.retryable === false,
  );
  await assert.rejects(
    queryDriveStatus(scripted([new Response("expired", { status: 401 })]).transport, { sessionUri: "https://upload.example.test/session/a", totalBytes: 10 }),
    (err: unknown) => err instanceof DriveUploadError && err.status === 401 && err.retryable === true,
  );
});
