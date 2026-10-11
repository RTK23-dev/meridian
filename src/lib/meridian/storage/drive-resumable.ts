/**
 * The Google Drive resumable upload protocol for artifact bytes. Google Drive holds the bytes of an artifact or an export.
 * It is not a record store: the session URI and the offset Drive has confirmed are recorded in Postgres by
 * artifact-upload.ts, and the access token is never recorded at all.
 *
 *   start:  POST the file metadata with uploadType=resumable. The session URI comes back in the Location header.
 *   send:   PUT a chunk with "Content-Range: bytes start-end/total". 308 means more is expected. Its Range header
 *           ("bytes=0-N") is the persisted range, so the next byte to send is N+1. No Range header means nothing is persisted.
 *   status: PUT with an unknown-length Content-Range (the total only) and no body. The same 308 answer, or 200/201 once the
 *           file is complete.
 *
 * Every chunk except the last is a multiple of 256 KiB. The caller injects fetch and the access token, so the protocol
 * runs against a stub in tests and against Drive in production.
 */

/** Drive requires chunks other than the last to be a multiple of this size. */
export const DRIVE_CHUNK_GRANULE_BYTES = 256 * 1024;

/** 8 MiB: a multiple of the granule, large enough that a large artifact takes few round trips. */
export const DEFAULT_DRIVE_CHUNK_BYTES = 32 * DRIVE_CHUNK_GRANULE_BYTES;

export const DRIVE_UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/drive/v3/files";
export const DRIVE_UPLOAD_FIELDS = "id,name,mimeType,size,webViewLink";

/**
 * A failed Drive request. `retryable` is true for a dropped connection, a throttle, a server error, or an expired access
 * token. It is false for a rejected request, and for a session Drive no longer knows (404 or 410), which needs a new session.
 */
export class DriveUploadError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(message: string, status: number | null, retryable: boolean) {
    super(message);
    this.name = "DriveUploadError";
    this.status = status;
    this.retryable = retryable;
  }
}

/** The part of the environment the protocol needs: a fetch and a way to get a current access token. */
export type ResumableTransport = {
  fetch: typeof fetch;
  /** Returns a current access token. Throws a non-retryable DriveUploadError when Drive is not configured. */
  accessToken: () => Promise<string>;
};

export type DriveUploadedFile = {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  webViewLink?: string;
};

export type DriveUploadStatus = { complete: false; persistedBytes: number } | { complete: true; file: DriveUploadedFile };

export function assertDriveChunkBytes(chunkBytes: number): void {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes % DRIVE_CHUNK_GRANULE_BYTES !== 0) {
    throw new Error(`Drive upload chunks must be a positive multiple of ${DRIVE_CHUNK_GRANULE_BYTES} bytes (256 KiB). Got ${chunkBytes}.`);
  }
}

/** The number of bytes Drive has persisted, from a 308 Range header. No header means none persisted. */
export function parsePersistedBytes(range: string | null): number {
  if (range === null) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range.trim());
  if (!match) throw new DriveUploadError(`Drive returned an unreadable upload Range header '${range}'.`, 308, true);
  return Number(match[1]) + 1;
}

export function contentRange(startInclusive: number, endExclusive: number, total: number): string {
  return `bytes ${startInclusive}-${endExclusive - 1}/${total}`;
}

/** Starts a resumable session for `totalBytes` and returns its session URI. */
export async function startDriveSession(
  transport: ResumableTransport,
  input: { metadata: Record<string, unknown>; mimeType: string; totalBytes: number },
): Promise<string> {
  const token = await transport.accessToken();
  const res = await transport.fetch(`${DRIVE_UPLOAD_ENDPOINT}?uploadType=resumable&fields=${DRIVE_UPLOAD_FIELDS}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": input.mimeType,
      "X-Upload-Content-Length": String(input.totalBytes),
    },
    body: JSON.stringify(input.metadata),
  });
  if (!res.ok) throw await httpError(res, "Google Drive resumable upload start");
  const location = res.headers.get("location");
  if (!location) throw new DriveUploadError("Google Drive did not return a resumable upload session URI.", res.status, true);
  return location;
}

/** Asks Drive how many bytes of the session it has persisted. */
export async function queryDriveStatus(
  transport: ResumableTransport,
  input: { sessionUri: string; totalBytes: number },
): Promise<DriveUploadStatus> {
  return putToSession(transport, input.sessionUri, {
    range: `bytes */${input.totalBytes}`,
    body: new Uint8Array(0),
  });
}

/** Sends `chunk` at `offset`. The answer says what Drive has persisted, which can be less than the chunk. */
export async function sendDriveChunk(
  transport: ResumableTransport,
  input: { sessionUri: string; totalBytes: number; offset: number; chunk: Uint8Array },
): Promise<DriveUploadStatus> {
  const endExclusive = input.offset + input.chunk.byteLength;
  return putToSession(transport, input.sessionUri, {
    range: contentRange(input.offset, endExclusive, input.totalBytes),
    body: input.chunk,
  });
}

async function putToSession(
  transport: ResumableTransport,
  sessionUri: string,
  request: { range: string; body: Uint8Array },
): Promise<DriveUploadStatus> {
  const token = await transport.accessToken();
  const res = await transport.fetch(sessionUri, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Range": request.range,
      "Content-Length": String(request.body.byteLength),
    },
    body: Buffer.from(request.body),
  });
  if (res.status === 308) {
    const persistedBytes = parsePersistedBytes(res.headers.get("range"));
    await res.arrayBuffer().catch(() => undefined);
    return { complete: false, persistedBytes };
  }
  if (res.status === 200 || res.status === 201) {
    return { complete: true, file: parseUploadedFile(await res.json()) };
  }
  throw await httpError(res, "Google Drive resumable upload");
}

function parseUploadedFile(value: unknown): DriveUploadedFile {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!record || typeof record.id !== "string" || !record.id) {
    throw new DriveUploadError("Google Drive completed the upload but returned no file id.", 200, true);
  }
  const size = typeof record.size === "string" || typeof record.size === "number" ? Number(record.size) : null;
  return {
    id: record.id,
    name: typeof record.name === "string" ? record.name : "",
    mimeType: typeof record.mimeType === "string" ? record.mimeType : "",
    size: size !== null && Number.isFinite(size) ? size : null,
    webViewLink: typeof record.webViewLink === "string" ? record.webViewLink : undefined,
  };
}

async function httpError(res: Response, label: string): Promise<DriveUploadError> {
  const body = (await res.text().catch(() => "")).slice(0, 500);
  const retryable = res.status === 401 || res.status === 408 || res.status === 429 || res.status >= 500;
  return new DriveUploadError(`${label} failed (HTTP ${res.status})${body ? `: ${body}` : ""}`, res.status, retryable);
}
