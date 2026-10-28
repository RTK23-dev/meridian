/**
 * A stateful stand-in for the Google Drive resumable upload endpoint, for tests. It does no network I/O. It keeps the bytes
 * it persists, so a test can check the content Drive ended up with, and it records every request so a test can check the
 * exact Content-Range headers and the status queries.
 */

export type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
};

/** What the fake does with one chunk PUT. */
export type ChunkAction =
  | { kind: "accept" }
  /** The connection drops. Drive keeps `persist` bytes of the chunk (0 by default) and the request throws. */
  | { kind: "drop"; persist?: number }
  /** Drive answers with this status and persists nothing. */
  | { kind: "status"; code: number };

export type ChunkInfo = { index: number; start: number; endExclusive: number; total: number };

export const FAKE_DRIVE_SESSION_PREFIX = "https://upload.example.test/session/";

export function fakeDriveUpload(script: (chunk: ChunkInfo) => ChunkAction = () => ({ kind: "accept" })) {
  type Session = { total: number; mimeType: string; fileId: string; persisted: Uint8Array[]; persistedLength: number };
  const sessions = new Map<string, Session>();
  const requests: RecordedRequest[] = [];
  let sessionCounter = 0;
  let chunkCounter = 0;
  // File ids are unique across fakes, so several test runs can share one database without tripping its unique key.
  const runId = Math.random().toString(36).slice(2, 10);
  const fileIds: string[] = [];
  /** When set, every PUT to a session answers with this status and persists nothing (for retry-cap tests). */
  const control = { failAllWith: null as number | null };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = init?.body instanceof Uint8Array ? new Uint8Array(init.body) : null;
    requests.push({ url, method, headers, body });

    if (method === "POST" && url.startsWith("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable")) {
      sessionCounter += 1;
      const uri = `${FAKE_DRIVE_SESSION_PREFIX}${sessionCounter}`;
      fileIds.push(`drive-file-${runId}-${sessionCounter}`);
      sessions.set(uri, {
        total: Number(headers["x-upload-content-length"]),
        mimeType: headers["x-upload-content-type"] ?? "application/octet-stream",
        fileId: `drive-file-${runId}-${sessionCounter}`,
        persisted: [],
        persistedLength: 0,
      });
      return new Response(null, { status: 200, headers: { location: uri } });
    }

    const session = sessions.get(url);
    if (method !== "PUT" || !session) return new Response("no such session", { status: 404 });
    if (control.failAllWith !== null) return new Response("unavailable", { status: control.failAllWith });

    const range = headers["content-range"] ?? "";
    const statusQuery = /^bytes \*\/(\d+)$/.exec(range);
    if (statusQuery) {
      return persistedResponse(session);
    }

    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    if (!match || !body) return new Response("bad content range", { status: 400 });
    const start = Number(match[1]);
    const endExclusive = Number(match[2]) + 1;
    const total = Number(match[3]);
    const action = script({ index: chunkCounter, start, endExclusive, total });
    chunkCounter += 1;

    if (action.kind === "status") return new Response("rejected", { status: action.code });
    if (start !== session.persistedLength) {
      // Drive takes bytes only from the persisted offset. A mismatch is a client bug, so it is refused.
      return new Response(`expected offset ${session.persistedLength}, got ${start}`, { status: 400 });
    }
    if (action.kind === "drop") {
      const kept = body.subarray(0, Math.min(action.persist ?? 0, body.byteLength));
      if (kept.byteLength > 0) {
        session.persisted.push(new Uint8Array(kept));
        session.persistedLength += kept.byteLength;
      }
      throw new TypeError("fetch failed: socket hang up");
    }
    session.persisted.push(body);
    session.persistedLength += body.byteLength;
    return persistedResponse(session);
  }) as typeof fetch;

  function persistedResponse(session: Session): Response {
    if (session.persistedLength >= session.total) {
      return new Response(
        JSON.stringify({ id: session.fileId, name: "artifact", mimeType: session.mimeType, size: String(session.total) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (session.persistedLength === 0) return new Response(null, { status: 308 });
    return new Response(null, { status: 308, headers: { range: `bytes=0-${session.persistedLength - 1}` } });
  }

  return {
    fetch: fetchImpl,
    requests,
    control,
    /** The bytes persisted for one session, in order. */
    persistedBytes(sessionUri: string): Buffer {
      const session = sessions.get(sessionUri);
      if (!session) throw new Error(`no session ${sessionUri}`);
      return Buffer.concat(session.persisted.map((part) => Buffer.from(part)));
    },
    /** The Drive file ids of the sessions, in the order they were started. */
    fileIds(): string[] {
      return [...fileIds];
    },
    /** Session URIs in the order they were started. */
    sessionUris(): string[] {
      return [...sessions.keys()];
    },
    /** Requests whose Content-Range is a chunk (not a status query), as their range strings. */
    chunkRanges(): string[] {
      return requests
        .filter((r) => r.method === "PUT" && r.headers["content-range"] && !r.headers["content-range"].startsWith("bytes */"))
        .map((r) => r.headers["content-range"]!);
    },
  };
}

/** Deterministic bytes, so a test can check exactly what Drive persisted. */
export function patternBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + 7) & 0xff;
  return out;
}
