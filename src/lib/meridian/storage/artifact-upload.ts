/**
 * Resumable upload of artifact bytes to Google Drive, with the upload's state recorded in Postgres.
 *
 * Postgres is the system of record: artifact_upload_sessions holds the session, its confirmed offset, its attempts and its
 * outcome, and storage_objects holds the stored-object row. Google Drive holds the bytes only. The access token is never
 * recorded.
 *
 * A session row is created before Drive is called, so a failed start is visible too. Each attempt syncs with Drive first,
 * because Drive's persisted range is the truth: a chunk can land at Drive after the process that sent it has died. Failed
 * attempts back off, and after `maxFailures` in a row without progress the upload is marked failed and stays visible.
 *
 * The bytes themselves are not stored in Postgres. A resumed upload is given the same bytes again by its caller, and it is
 * refused unless their SHA-256 and length match the session.
 */
import { createHash, randomUUID } from "node:crypto";
import type { AssetLifecycle } from "./object-store.ts";
import {
  DEFAULT_DRIVE_CHUNK_BYTES,
  DriveUploadError,
  assertDriveChunkBytes,
  queryDriveStatus,
  sendDriveChunk,
  startDriveSession,
  type DriveUploadedFile,
  type ResumableTransport,
} from "./drive-resumable.ts";

export const DEFAULT_MAX_FAILURES = 6;

export type ArtifactUploadScope = { organizationId: string; brandId: string };

export type ArtifactUploadSession = ArtifactUploadScope & {
  id: string;
  storageKey: string;
  mimeType: string;
  totalBytes: number;
  sha256: string;
  /** Server-side only. It addresses the Drive upload session, so it is never returned to a browser. */
  sessionUri: string;
  /** Bytes Drive has confirmed as persisted. Resume continues from here. */
  confirmedOffset: number;
  status: "uploading" | "completed" | "failed";
  attempts: number;
  lastError: string | null;
  providerFileId: string | null;
  storageObjectId: string | null;
  updatedAt: string;
};

export type NewArtifactUploadSession = ArtifactUploadScope & {
  id: string;
  storageKey: string;
  mimeType: string;
  totalBytes: number;
  sha256: string;
};

/** The storage_objects row for a completed upload. Only callers that own that row pass one; see drive.ts. */
export type StorageObjectRecordInput = { lifecycle: AssetLifecycle };

/** The Postgres side of an upload. Every method is scoped by organization and brand. */
export interface ArtifactUploadStore {
  /** The one active session for this storage key in the brand, if any. */
  findActive(scope: ArtifactUploadScope, storageKey: string): Promise<ArtifactUploadSession | null>;
  /** Creates an active session with no Drive URI yet. Returns false when an active session already holds this key. */
  insertActive(row: NewArtifactUploadSession): Promise<boolean>;
  load(scope: ArtifactUploadScope, sessionId: string): Promise<ArtifactUploadSession | null>;
  /** Stores the Drive session URI if none is stored yet. Returns the URI now stored, or null if the session is not active. */
  setSessionUri(scope: ArtifactUploadScope, sessionId: string, sessionUri: string): Promise<string | null>;
  recordProgress(
    scope: ArtifactUploadScope,
    sessionId: string,
    progress: { confirmedOffset: number; attempts: number; lastError: string | null },
  ): Promise<void>;
  /**
   * Marks the session completed. With `storageObject`, the storage_objects row is written in the same transaction. If that
   * row would conflict with different bytes, the call throws and the session is not completed.
   */
  complete(
    scope: ArtifactUploadScope,
    sessionId: string,
    input: { providerFileId: string; storageObject?: StorageObjectRecordInput },
  ): Promise<void>;
  fail(scope: ArtifactUploadScope, sessionId: string, input: { attempts: number; lastError: string }): Promise<void>;
}

export type ArtifactUploadPolicy = {
  /** Bytes per chunk. A positive multiple of 256 KiB. Default 8 MiB. */
  chunkBytes?: number;
  /** Consecutive failed attempts without progress before the upload is marked failed. Default 6. */
  maxFailures?: number;
  /** Wait before the next attempt, from the number of failures so far. Default: 1 s doubling, capped at 30 s. */
  backoffMs?: (failures: number) => number;
  sleep?: (ms: number) => Promise<void>;
};

export type ArtifactUploadDeps = ArtifactUploadPolicy & {
  store: ArtifactUploadStore;
  transport: ResumableTransport;
  /** Called after Drive answers 401, so the next request mints a fresh access token. */
  onUnauthorized?: () => void;
};

export type ArtifactUploadRequest = ArtifactUploadScope & {
  storageKey: string;
  mimeType: string;
  bytes: Uint8Array;
  /** The Drive file resource (name, parents, properties). Sent when the session starts. */
  metadata: Record<string, unknown>;
  storageObject?: StorageObjectRecordInput;
};

export type ArtifactUploadOutcome =
  | { status: "completed"; sessionId: string; resumed: boolean; file: DriveUploadedFile }
  | { status: "failed"; sessionId: string; attempts: number; reason: string };

export type ArtifactResumeOutcome = ArtifactUploadOutcome | { status: "not_found" };

/** The bytes given for an upload do not match the session they would continue. */
export class ArtifactUploadConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactUploadConflictError";
  }
}

export function defaultBackoffMs(failures: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, failures - 1));
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Starts an upload of `request.bytes`, or resumes the active upload for the same storage key. */
export async function uploadArtifactToDrive(deps: ArtifactUploadDeps, request: ArtifactUploadRequest): Promise<ArtifactUploadOutcome> {
  const policy = resolvePolicy(deps);
  const scope = { organizationId: request.organizationId, brandId: request.brandId };
  const totalBytes = request.bytes.byteLength;
  if (totalBytes === 0) throw new Error("An empty artifact is not uploaded.");
  const sha256 = sha256Hex(request.bytes);

  const active = await deps.store.findActive(scope, request.storageKey);
  if (active) {
    assertSameContent(active, sha256, totalBytes);
    return transfer(deps, policy, active, request.bytes, { metadata: request.metadata, storageObject: request.storageObject, resumed: true });
  }

  const id = randomUUID();
  const created = { ...scope, id, storageKey: request.storageKey, mimeType: request.mimeType, totalBytes, sha256 };
  if (await deps.store.insertActive(created)) {
    const session: ArtifactUploadSession = {
      ...created,
      sessionUri: "",
      confirmedOffset: 0,
      status: "uploading",
      attempts: 0,
      lastError: null,
      providerFileId: null,
      storageObjectId: null,
      updatedAt: new Date().toISOString(),
    };
    return transfer(deps, policy, session, request.bytes, { metadata: request.metadata, storageObject: request.storageObject, resumed: false });
  }

  // Another process created the active session first. Continue that one.
  const winner = await deps.store.findActive(scope, request.storageKey);
  if (!winner) throw new Error("The upload session for this storage key changed while it was being created. Try again.");
  assertSameContent(winner, sha256, totalBytes);
  return transfer(deps, policy, winner, request.bytes, { metadata: request.metadata, storageObject: request.storageObject, resumed: true });
}

/** Continues one session by id. The session must belong to the organization and brand given. */
export async function resumeArtifactUpload(
  deps: ArtifactUploadDeps,
  input: ArtifactUploadScope & { sessionId: string; bytes: Uint8Array; metadata: Record<string, unknown>; storageObject?: StorageObjectRecordInput },
): Promise<ArtifactResumeOutcome> {
  const policy = resolvePolicy(deps);
  const scope = { organizationId: input.organizationId, brandId: input.brandId };
  const session = await deps.store.load(scope, input.sessionId);
  if (!session) return { status: "not_found" };
  if (session.status === "completed") {
    return {
      status: "completed",
      sessionId: session.id,
      resumed: true,
      file: { id: session.providerFileId ?? "", name: session.storageKey.split("/").pop() ?? "", mimeType: session.mimeType, size: session.totalBytes },
    };
  }
  if (session.status === "failed") {
    return { status: "failed", sessionId: session.id, attempts: session.attempts, reason: session.lastError ?? "The upload failed." };
  }
  assertSameContent(session, sha256Hex(input.bytes), input.bytes.byteLength);
  return transfer(deps, policy, session, input.bytes, { metadata: input.metadata, storageObject: input.storageObject, resumed: true });
}

type ResolvedPolicy = { chunkBytes: number; maxFailures: number; backoffMs: (failures: number) => number; sleep: (ms: number) => Promise<void> };

function resolvePolicy(deps: ArtifactUploadPolicy): ResolvedPolicy {
  const chunkBytes = deps.chunkBytes ?? DEFAULT_DRIVE_CHUNK_BYTES;
  assertDriveChunkBytes(chunkBytes);
  const maxFailures = deps.maxFailures ?? DEFAULT_MAX_FAILURES;
  if (!Number.isSafeInteger(maxFailures) || maxFailures < 1) throw new Error("maxFailures must be a whole number of at least 1.");
  return {
    chunkBytes,
    maxFailures,
    backoffMs: deps.backoffMs ?? defaultBackoffMs,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

function assertSameContent(session: ArtifactUploadSession, sha256: string, totalBytes: number): void {
  if (session.sha256 !== sha256 || session.totalBytes !== totalBytes) {
    throw new ArtifactUploadConflictError("An upload for this storage key is already in progress with different bytes. Nothing was sent.");
  }
}

function isRetryable(err: unknown): boolean {
  return err instanceof DriveUploadError ? err.retryable : true;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The attempt loop. It starts the Drive session if none exists, syncs the offset with Drive, sends chunks from the offset
 * Drive confirms, and retries with backoff. Every loop either makes progress, fails a counted attempt, or returns.
 */
async function transfer(
  deps: ArtifactUploadDeps,
  policy: ResolvedPolicy,
  session: ArtifactUploadSession,
  bytes: Uint8Array,
  options: { metadata: Record<string, unknown>; storageObject?: StorageObjectRecordInput; resumed: boolean },
): Promise<ArtifactUploadOutcome> {
  const scope = { organizationId: session.organizationId, brandId: session.brandId };
  const total = session.totalBytes;
  let sessionUri = session.sessionUri;
  let offset = session.confirmedOffset;
  let failures = session.attempts;
  let needSync = sessionUri !== "";

  for (;;) {
    try {
      if (!sessionUri) {
        const started = await startDriveSession(deps.transport, { metadata: options.metadata, mimeType: session.mimeType, totalBytes: total });
        const stored = await deps.store.setSessionUri(scope, session.id, started);
        if (stored === null) throw new Error("The upload session is no longer active.");
        sessionUri = stored;
        offset = 0;
        // Another process may have stored its session first. Its Drive session can hold bytes, so ask Drive where it stands.
        needSync = stored !== started;
      }

      if (needSync) {
        const status = await queryDriveStatus(deps.transport, { sessionUri, totalBytes: total });
        if (status.complete) return await finish(deps, scope, session, status.file, options, failures);
        offset = status.persistedBytes;
        needSync = false;
      }

      if (offset >= total) {
        // Every byte is persisted but the file resource has not come back. Ask Drive again.
        needSync = true;
        throw new DriveUploadError("Google Drive has every byte but has not returned the finished file yet.", null, true);
      }

      const end = Math.min(offset + policy.chunkBytes, total);
      const status = await sendDriveChunk(deps.transport, { sessionUri, totalBytes: total, offset, chunk: bytes.subarray(offset, end) });
      if (status.complete) return await finish(deps, scope, session, status.file, options, failures);
      if (status.persistedBytes > total) {
        throw new DriveUploadError(`Google Drive reports ${status.persistedBytes} bytes persisted, more than the ${total} in the file.`, 308, false);
      }
      if (status.persistedBytes <= offset) {
        needSync = true;
        throw new DriveUploadError("Google Drive persisted no new bytes for this chunk.", 308, true);
      }
      offset = status.persistedBytes;
      failures = 0;
      await deps.store.recordProgress(scope, session.id, { confirmedOffset: offset, attempts: 0, lastError: null });
    } catch (err) {
      const reason = messageOf(err);
      if (err instanceof DriveUploadError && err.status === 401) deps.onUnauthorized?.();
      if (!isRetryable(err)) {
        return failUpload(deps, scope, session.id, failures + 1, reason);
      }
      needSync = sessionUri !== "";
      failures += 1;
      if (failures >= policy.maxFailures) {
        return failUpload(deps, scope, session.id, failures, reason);
      }
      await deps.store.recordProgress(scope, session.id, { confirmedOffset: offset, attempts: failures, lastError: reason });
      await policy.sleep(policy.backoffMs(failures));
    }
  }
}

async function finish(
  deps: ArtifactUploadDeps,
  scope: ArtifactUploadScope,
  session: ArtifactUploadSession,
  file: DriveUploadedFile,
  options: { storageObject?: StorageObjectRecordInput; resumed: boolean },
  failures: number,
): Promise<ArtifactUploadOutcome> {
  if (file.size !== null && file.size !== session.totalBytes) {
    return failUpload(deps, scope, session.id, failures + 1, `Google Drive stored ${file.size} bytes; ${session.totalBytes} were sent.`);
  }
  try {
    await deps.store.complete(scope, session.id, { providerFileId: file.id, storageObject: options.storageObject });
  } catch (err) {
    return failUpload(deps, scope, session.id, failures + 1, messageOf(err));
  }
  return { status: "completed", sessionId: session.id, resumed: options.resumed, file };
}

async function failUpload(
  deps: ArtifactUploadDeps,
  scope: ArtifactUploadScope,
  sessionId: string,
  attempts: number,
  lastError: string,
): Promise<ArtifactUploadOutcome> {
  await deps.store.fail(scope, sessionId, { attempts, lastError });
  return {
    status: "failed",
    sessionId,
    attempts,
    reason: `The upload stopped after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${lastError}`,
  };
}
