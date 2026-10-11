/**
 * Idempotent Durable Production Artifact Finalizer
 *
 * In accordance with Section P0.4:
 * Invariant: COMPLETED means the output was obtained, validated, durably stored,
 * linked in storage_objects/job records, and can be retrieved. A provider saying
 * "completed" is not sufficient.
 *
 * Shared idempotent finalization used by both synchronous provider completion
 * and asynchronous background poller / recovery workers.
 */

import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingMessage, RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import type { Sql } from "../learning/store.ts";
import { defaultArtifactDrive, type ArtifactDrive } from "../storage/artifact-drive.ts";
import { resolveAndPinHost } from "../sources/fetch-page.server.ts";
import { ipIsBlocked, publicUrlIssue } from "../sources/public-url.ts";
import { evaluateProductionPostflight } from "./postflight.ts";
import type { ProductionJob } from "./types.ts";
import { detectArtifactType } from "./mime-detector.ts";

export class ArtifactIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactIntegrityError";
  }
}

export interface ArtifactFinalizeInput {
  jobId: string;
  organizationId: string;
  brandId: string;
  provider: string;
  providerJobId?: string;
  runId?: string;
  rawArtifact: {
    uri?: string;
    mimeType?: string;
    bytes?: Uint8Array;
    base64?: string;
    sha256?: string;
    byteSize?: number;
  };
  options?: {
    driveClient?: ArtifactDrive;
    /** A test transport for provider artifact URLs. Production omits it, so downloads connect to the addresses they validated. */
    fetchImpl?: typeof fetch;
    /** The DNS answers used to validate an artifact host. Defaults to the system resolver. */
    resolver?: ArtifactResolver;
    durationMs?: number;
    skipPostflight?: boolean;
    job?: ProductionJob;
  };
}

export interface ArtifactFinalizeResult {
  success: boolean;
  status:
    | "COMPLETED"
    | "WAITING_FOR_ARTIFACT"
    | "STORAGE_PERSISTENCE_FAILED"
    | "POSTFLIGHT_FAILED"
    | "FAILED";
  artifactId?: string;
  storageKey?: string;
  sha256?: string;
  byteSize?: number;
  mimeType?: string;
  errorCode?: string;
  error?: string;
}

/**
 * Largest provider artifact the finalizer reads. The whole body is held in memory before it is stored in Drive, so this cap
 * bounds what one download can take from a worker. 200 MB is well above a short-form render at ordinary bitrates, and small
 * enough that a runaway response cannot exhaust a worker. It is a judgement, not a measured provider maximum.
 */
export const MAX_ARTIFACT_BYTES = 200 * 1024 * 1024;

/** Time allowed for one artifact download, from the request to the last body byte. */
export const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 30_000;

/** Redirects followed for one artifact. Every hop is checked again, so this limit only bounds a loop. */
const MAX_ARTIFACT_REDIRECTS = 3;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ARTIFACT_ACCEPT = "video/*,image/*,application/octet-stream;q=0.9";

type ResolvedAddress = { address: string; family: number };
export type ArtifactResolver = (hostname: string) => Promise<ResolvedAddress[]>;

const systemResolver: ArtifactResolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

export type ArtifactDownloadOptions = {
  /** A test transport. The caller then owns the connection, so DNS is not pinned here. Omitted, the download connects to the addresses it validated. */
  fetchImpl?: typeof fetch;
  resolver?: ArtifactResolver;
  timeoutMs?: number;
  maxBytes?: number;
};

export type ArtifactDownload =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; status: "WAITING_FOR_ARTIFACT"; error: string }
  | { ok: false; status: "FAILED"; errorCode: "ARTIFACT_URL_REFUSED" | "ARTIFACT_TOO_LARGE"; error: string };

/** A URL, host or redirect the policy refuses. The same artifact cannot succeed on retry, so the job fails. */
class RefusedArtifactUrl extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusedArtifactUrl";
  }
}

/** A body that is, or is declared as, larger than the cap. It cannot succeed on retry either. */
class OversizedArtifact extends Error {
  constructor() {
    super("The artifact is larger than the download limit.");
    this.name = "OversizedArtifact";
  }
}

/**
 * Downloads one provider artifact. Only https is accepted, and each hop must be a public host. The pinned transport connects
 * only to the addresses it validated. Redirects are followed one hop at a time with the same checks. The whole download has
 * one deadline, and the body is read only up to the byte cap. Failures are either refused (permanent) or retryable.
 */
export async function downloadProviderArtifact(rawUri: string, options: ArtifactDownloadOptions = {}): Promise<ArtifactDownload> {
  const timeoutMs = options.timeoutMs ?? ARTIFACT_DOWNLOAD_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_ARTIFACT_BYTES;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const timeout = new Error("The artifact download timed out.");
      controller.abort(timeout);
      reject(timeout);
    }, timeoutMs);
  });
  // Promise.race subscribes to the deadline; this only keeps a late rejection from surfacing as unhandled.
  deadline.catch(() => undefined);

  try {
    const bytes = await Promise.race([readArtifact(rawUri, { ...options, maxBytes }, controller.signal), deadline]);
    return { ok: true, bytes };
  } catch (err) {
    controller.abort(err);
    if (err instanceof RefusedArtifactUrl) return { ok: false, status: "FAILED", errorCode: "ARTIFACT_URL_REFUSED", error: err.message };
    if (err instanceof OversizedArtifact) return { ok: false, status: "FAILED", errorCode: "ARTIFACT_TOO_LARGE", error: err.message };
    return {
      ok: false,
      status: "WAITING_FOR_ARTIFACT",
      error: err instanceof Error ? err.message : "The artifact download did not complete.",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readArtifact(
  rawUri: string,
  options: ArtifactDownloadOptions & { maxBytes: number },
  signal: AbortSignal,
): Promise<Uint8Array> {
  let url: URL;
  try {
    url = new URL(rawUri);
  } catch {
    throw new RefusedArtifactUrl("The artifact URL is not valid.");
  }

  for (let redirects = 0; ; redirects += 1) {
    if (url.protocol !== "https:") throw new RefusedArtifactUrl("Artifact URLs must use https.");
    const issue = publicUrlIssue(url.toString());
    if (issue) throw new RefusedArtifactUrl(`The artifact host is refused. ${issue}`);

    const response = options.fetchImpl
      ? await options.fetchImpl(url.toString(), { method: "GET", redirect: "manual", headers: { accept: ARTIFACT_ACCEPT }, signal })
      : await pinnedGet(url, signal, options.resolver);

    if (response.type === "opaqueredirect" || REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      if (!location || redirects >= MAX_ARTIFACT_REDIRECTS) {
        throw new RefusedArtifactUrl("The artifact URL redirected more times than allowed, or to no target.");
      }
      try {
        url = new URL(location, url);
      } catch {
        throw new RefusedArtifactUrl("The artifact redirect target is not a valid URL.");
      }
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`The artifact host returned ${response.status}.`);
    }

    const declared = response.headers.get("content-length");
    if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > options.maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new OversizedArtifact();
    }
    return readCapped(response, options.maxBytes);
  }
}

/** Resolves once, refuses any private or loopback answer, and connects only to the validated addresses. */
async function pinnedGet(url: URL, signal: AbortSignal, resolver?: ArtifactResolver): Promise<Response> {
  const seen: { records?: ResolvedAddress[] } = {};
  let lookup: NonNullable<RequestOptions["lookup"]>;
  try {
    lookup = await resolveAndPinHost(url.hostname, async (hostname) => {
      const records = await (resolver ?? systemResolver)(hostname);
      seen.records = records;
      return records;
    });
  } catch {
    // A private answer is a policy refusal. A failed lookup is retried, like any other transient download failure.
    if (seen.records?.some((record) => ipIsBlocked(record.address))) {
      throw new RefusedArtifactUrl("That host does not resolve to a public address.");
    }
    throw new Error("The artifact host could not be resolved.");
  }
  return requestPinned(url, lookup, signal);
}

function requestPinned(url: URL, lookup: NonNullable<RequestOptions["lookup"]>, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      { method: "GET", signal, headers: { accept: ARTIFACT_ACCEPT }, lookup },
      (incoming) => {
        try {
          resolve(toResponse(incoming));
        } catch (err) {
          incoming.resume();
          reject(err);
        }
      },
    );
    request.once("error", reject);
    request.end();
  });
}

function toResponse(incoming: IncomingMessage): Response {
  const status = incoming.statusCode ?? 0;
  if (status < 200 || status > 599) throw new Error("The artifact host returned an invalid status.");
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (typeof value === "string") {
      headers.set(name, value);
    }
  }
  const nullBody = status === 204 || status === 205 || status === 304;
  if (nullBody) incoming.resume();
  const body = nullBody ? null : (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>);
  return new Response(body, { status, headers });
}

/** Reads the body, and stops and cancels as soon as it passes the cap. A body past the cap is never held in full. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    received += step.value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new OversizedArtifact();
    }
    chunks.push(step.value);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function finalizeProductionArtifact(
  sql: Sql,
  input: ArtifactFinalizeInput,
): Promise<ArtifactFinalizeResult> {
  const drive = input.options?.driveClient || defaultArtifactDrive();

  const ownedJob = await sql<{ id: string }>`
    select id from production_jobs
    where id = ${input.jobId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
    limit 1
  `;
  if (!ownedJob[0]) {
    return {
      success: false,
      status: "FAILED",
      errorCode: "PRODUCTION_JOB_SCOPE_MISMATCH",
      error: "Production job was not found in the requested tenant scope.",
    };
  }

  // 1. Normalize and extract complete bytes
  let bytes: Uint8Array | null = null;
  const raw = input.rawArtifact;

  if (raw.bytes && raw.bytes.byteLength > 0) {
    bytes = raw.bytes;
  } else if (raw.base64 && typeof raw.base64 === "string") {
    try {
      const buf = Buffer.from(raw.base64, "base64");
      if (buf.byteLength > 0) {
        bytes = new Uint8Array(buf);
      }
    } catch {
      // Base64 decode failed
    }
  } else if (raw.uri && raw.uri.startsWith("data:")) {
    try {
      const match = raw.uri.match(/^data:([^;]+);base64,(.+)$/);
      if (match && match[2]) {
        const buf = Buffer.from(match[2], "base64");
        if (buf.byteLength > 0) {
          bytes = new Uint8Array(buf);
        }
      }
    } catch {
      // Data URI decode failed
    }
  } else if (raw.uri && (raw.uri.startsWith("http://") || raw.uri.startsWith("https://"))) {
    const download = await downloadProviderArtifact(raw.uri, {
      fetchImpl: input.options?.fetchImpl,
      resolver: input.options?.resolver,
    });
    if (!download.ok) {
      // A refused or oversized URL is permanent and fails the job. Any other failure is retried by the caller.
      if (download.status === "FAILED") {
        return { success: false, status: "FAILED", errorCode: download.errorCode, error: download.error };
      }
      return { success: false, status: "WAITING_FOR_ARTIFACT", error: download.error };
    }
    bytes = download.bytes;
  } else if (raw.uri && input.provider === "manual_cloud") {
    try {
      const driveFile = await drive.get(raw.uri, input.organizationId);
      if (driveFile) {
        bytes = driveFile.bytes;
      }
    } catch {
      // Drive fetch failed
    }
  }

  // 2. Validate bytes presence and minimal sensible size
  if (!bytes || bytes.byteLength < 50) {
    return {
      success: false,
      status: "WAITING_FOR_ARTIFACT",
      error: "Artifact media bytes are not available or corrupted.",
    };
  }

  // 2b. Strict fail-closed magic byte MIME detection
  let detected: import("./mime-detector.ts").DetectedArtifactFormat;
  let canonicalArtifactId: string;
  try {
    detected = detectArtifactType(bytes);
  } catch (err: any) {
    await sql`
      update production_jobs
      set status = 'STORAGE_PERSISTENCE_FAILED',
          error_code = 'UNRECOGNIZED_MEDIA_FORMAT',
          last_polled_at = now(),
          updated_at = now()
      where id = ${input.jobId}
        and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
    `;
    return {
      success: false,
      status: "STORAGE_PERSISTENCE_FAILED",
      errorCode: "UNRECOGNIZED_MEDIA_FORMAT",
      error: `Artifact media type detection failed: ${err?.message}`,
    };
  }

  const mimeType = detected.mimeType;

  // 3. Postflight QC for video media
  if (!input.options?.skipPostflight && mimeType.startsWith("video/")) {
    const postflightJob: ProductionJob = input.options?.job || {
      jobId: input.jobId,
      organizationId: input.organizationId,
      brandId: input.brandId,
      providerId: input.provider,
      status: "COMPLETED",
      costEstimateUsd: 0,
      creativeSpec: {} as any,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const postflight = evaluateProductionPostflight({
      job: postflightJob,
      videoBytes: bytes,
      durationMs: input.options?.durationMs,
    });

    if (!postflight.passed) {
      await sql`
        update production_jobs
        set status = 'POSTFLIGHT_FAILED',
            error_code = 'POSTFLIGHT_DEFECTIVE',
            last_polled_at = now(),
            updated_at = now()
        where id = ${input.jobId}
          and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
      `;

      if (input.runId) {
        await sql`
          update assets
          set media_status = 'failed',
              lifecycle = 'rejected',
              qa_decision = 'rejected'
          where generation_run_id = ${input.runId}
        `;
      }

      return {
        success: false,
        status: "POSTFLIGHT_FAILED",
        errorCode: "POSTFLIGHT_DEFECTIVE",
        error: `Postflight QC rejected artifact: ${postflight.reasons.join("; ")}`,
      };
    }
  }

  // 4. Compute SHA-256 and metadata
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const byteSize = bytes.byteLength;
  const isVideo = mimeType.startsWith("video/");
  const ext = isVideo ? "mp4" : mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
  const storageKey = `${input.organizationId}/${input.brandId}/production/${input.jobId}/artifact.${ext}`;

  // Recover a prior verified write rather than creating another Drive object on retry.
  const existingObjects = await sql<{
    id: string;
    provider_file_id: string;
    sha256: string;
    size_bytes: string | number | bigint;
    mime_type: string;
  }>`
    select id, provider_file_id, sha256, size_bytes, mime_type
    from storage_objects
    where organization_id = ${input.organizationId} and brand_id = ${input.brandId} and name = ${storageKey}
    limit 1
  `;
  const existingObject = existingObjects[0];
  if (existingObject) {
    if (existingObject.sha256 !== sha256 || BigInt(existingObject.size_bytes) !== BigInt(byteSize) || existingObject.mime_type !== mimeType) {
      return {
        success: false,
        status: "STORAGE_PERSISTENCE_FAILED",
        errorCode: "ARTIFACT_IDEMPOTENCY_CONFLICT",
        error: "This production job already has a different stored artifact; refusing to overwrite it.",
      };
    }
    try {
      const stored = await drive.get(existingObject.provider_file_id, input.organizationId);
      const storedHash = stored?.bytes ? createHash("sha256").update(stored.bytes).digest("hex") : "";
      const storedType = stored?.bytes ? detectArtifactType(stored.bytes).mimeType : "";
      if (!stored?.bytes || storedHash !== sha256 || stored.bytes.byteLength !== byteSize || storedType !== mimeType) {
        throw new ArtifactIntegrityError("Existing stored artifact failed read-after-write verification.");
      }
      await sql`
        update production_jobs set status = 'COMPLETED', artifact_id = ${existingObject.id},
          error_code = null, last_polled_at = now(), updated_at = now()
        where id = ${input.jobId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
      `;
      return {
        success: true,
        status: "COMPLETED",
        artifactId: existingObject.id,
        storageKey,
        sha256,
        byteSize,
        mimeType,
      };
    } catch (err) {
      return {
        success: false,
        status: "STORAGE_PERSISTENCE_FAILED",
        errorCode: "ARTIFACT_INTEGRITY_MISMATCH",
        error: `Existing artifact retry verification failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // 5. Durably store in Google Drive object store
  let driveResult: { fileId: string; webViewLink?: string } | undefined;
  try {
    driveResult = await drive.put({
      organizationId: input.organizationId,
      brandId: input.brandId,
      path: storageKey,
      mimeType,
      bytes,
    });
  } catch (err: any) {
    // STORAGE_PERSISTENCE_FAILED: NEVER swallow storage error and claim completed!
    await sql`
      update production_jobs
      set status = 'STORAGE_PERSISTENCE_FAILED',
          error_code = 'STORAGE_PERSISTENCE_FAILED',
          last_polled_at = now(),
          updated_at = now()
      where id = ${input.jobId}
        and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
    `;

    return {
      success: false,
      status: "STORAGE_PERSISTENCE_FAILED",
      errorCode: "STORAGE_PERSISTENCE_FAILED",
      error: `Failed to persist artifact into Google Drive storage: ${err?.message || "Unknown storage error"}`,
    };
  }

  // 6. Idempotently commit storage_objects aligned with createGoogleDriveObjectStore lookup contract
  // Note: createSqlStorageMetadataRepository looks up by `name = ${key}`!
  // Therefore, `name` MUST be set to `storageKey` and `provider_file_id` MUST be `driveResult.fileId`.
  const artifactId = globalThis.crypto.randomUUID();
  const providerFileId = driveResult?.fileId || raw.uri || artifactId;

  // 5b. Read-after-write byte-level integrity verification
  try {
    const downloaded = await drive.get(providerFileId, input.organizationId);
    if (!downloaded || !downloaded.bytes || downloaded.bytes.byteLength === 0) {
      throw new ArtifactIntegrityError(
        `Drive download returned empty or missing bytes for file ID '${providerFileId}'`
      );
    }
    const downloadedHash = createHash("sha256").update(downloaded.bytes).digest("hex");
    if (downloadedHash !== sha256) {
      throw new ArtifactIntegrityError(
        `Byte verification mismatch: uploaded sha256 (${sha256}) !== downloaded sha256 (${downloadedHash})`
      );
    }
    if (downloaded.bytes.byteLength !== byteSize) {
      throw new ArtifactIntegrityError(
        `Byte size mismatch: uploaded size (${byteSize}) !== downloaded size (${downloaded.bytes.byteLength})`
      );
    }
  } catch (err: any) {
    await sql`
      update production_jobs
      set status = 'STORAGE_PERSISTENCE_FAILED',
          error_code = 'ARTIFACT_INTEGRITY_MISMATCH',
          last_polled_at = now(),
          updated_at = now()
      where id = ${input.jobId}
        and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
    `;
    return {
      success: false,
      status: "STORAGE_PERSISTENCE_FAILED",
      errorCode: "ARTIFACT_INTEGRITY_MISMATCH",
      error: `Artifact byte-level verification failed: ${err?.message}`,
    };
  }

  try {
    await sql`
      insert into storage_objects (
        id, organization_id, brand_id, provider, provider_file_id,
        name, mime_type, size_bytes, sha256, lifecycle, metadata, created_at, updated_at
      ) values (
        ${artifactId}, ${input.organizationId}, ${input.brandId}, 'google_drive', ${providerFileId},
        ${storageKey}, ${mimeType}, ${byteSize}, ${sha256}, 'approved',
        ${JSON.stringify({ key: storageKey, fileId: providerFileId })}, now(), now()
      )
      on conflict (organization_id, brand_id, name) do nothing
    `;

    // Read-after-write verification: ensure stored metadata matches
    const verifiedRows = await sql<{ id: string; provider_file_id: string; size_bytes: number; sha256: string; mime_type: string }>`
      select id, provider_file_id, size_bytes, sha256, mime_type
      from storage_objects
      where organization_id = ${input.organizationId}
        and brand_id = ${input.brandId}
        and name = ${storageKey}
      limit 1
    `;

    if (!verifiedRows[0]) {
      throw new Error("Read-after-write verification failed: storage metadata row is missing.");
    }
    if (verifiedRows[0].sha256 !== sha256 || Number(verifiedRows[0].size_bytes) !== byteSize || verifiedRows[0].mime_type !== mimeType) {
      throw new Error("Read-after-write verification failed: another finalizer stored different artifact bytes for this job.");
    }
    canonicalArtifactId = verifiedRows[0].id;
  } catch (dbErr: any) {
    await sql`
      update production_jobs
      set status = 'STORAGE_PERSISTENCE_FAILED',
          error_code = 'METADATA_PERSISTENCE_FAILED',
          last_polled_at = now(),
          updated_at = now()
      where id = ${input.jobId}
        and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
    `;

    return {
      success: false,
      status: "STORAGE_PERSISTENCE_FAILED",
      errorCode: "METADATA_PERSISTENCE_FAILED",
      error: `Failed to record durable storage metadata: ${dbErr?.message || String(dbErr)}`,
    };
  }

  // 7. ONLY now mark the job COMPLETED!
  await sql`
    update production_jobs
    set status = 'COMPLETED',
        artifact_id = ${canonicalArtifactId},
        error_code = null,
        last_polled_at = now(),
        updated_at = now()
    where id = ${input.jobId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
  `;

  return {
    success: true,
    status: "COMPLETED",
    artifactId: canonicalArtifactId,
    storageKey,
    sha256,
    byteSize,
    mimeType,
  };
}
