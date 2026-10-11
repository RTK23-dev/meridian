/**
 * The Postgres store for resumable artifact uploads. Postgres is the system of record for the upload session. Every
 * statement filters by organization_id and brand_id, so a session in one workspace cannot be read or changed from another.
 */
import type { Sql } from "../learning/store.ts";
import { isoTimestamp } from "../observability/timestamps.ts";
import type {
  ArtifactUploadScope,
  ArtifactUploadSession,
  ArtifactUploadStore,
  NewArtifactUploadSession,
  StorageObjectRecordInput,
} from "./artifact-upload.ts";

const COLUMNS = `id, organization_id, brand_id, storage_key, mime_type, total_bytes, sha256, session_uri, confirmed_offset,
  status, attempts, last_error, provider_file_id, storage_object_id, updated_at`;

type SessionRow = {
  id: string;
  organization_id: string;
  brand_id: string;
  storage_key: string;
  mime_type: string;
  total_bytes: string | number | bigint;
  sha256: string;
  session_uri: string;
  confirmed_offset: string | number | bigint;
  status: ArtifactUploadSession["status"];
  attempts: number;
  last_error: string | null;
  provider_file_id: string | null;
  storage_object_id: string | null;
  updated_at: unknown;
};

function toSession(row: SessionRow): ArtifactUploadSession {
  return {
    id: row.id,
    organizationId: row.organization_id,
    brandId: row.brand_id,
    storageKey: row.storage_key,
    mimeType: row.mime_type,
    totalBytes: Number(row.total_bytes),
    sha256: row.sha256,
    sessionUri: row.session_uri,
    confirmedOffset: Number(row.confirmed_offset),
    status: row.status,
    attempts: Number(row.attempts),
    lastError: row.last_error,
    providerFileId: row.provider_file_id,
    storageObjectId: row.storage_object_id,
    updatedAt: isoTimestamp(row.updated_at),
  };
}

export function createSqlArtifactUploadStore(sql: Sql): ArtifactUploadStore {
  return {
    async findActive(scope: ArtifactUploadScope, storageKey: string) {
      const rows = await sql.query<SessionRow>(
        `select ${COLUMNS} from artifact_upload_sessions
         where organization_id = $1 and brand_id = $2 and storage_key = $3 and status = 'uploading'
         limit 1`,
        [scope.organizationId, scope.brandId, storageKey],
      );
      return rows[0] ? toSession(rows[0]) : null;
    },

    async insertActive(row: NewArtifactUploadSession) {
      const inserted = await sql.query<{ id: string }>(
        `insert into artifact_upload_sessions (id, organization_id, brand_id, storage_key, mime_type, total_bytes, sha256, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, now())
         on conflict (organization_id, brand_id, storage_key) where status = 'uploading' do nothing
         returning id`,
        [row.id, row.organizationId, row.brandId, row.storageKey, row.mimeType, row.totalBytes, row.sha256],
      );
      return inserted.length === 1;
    },

    async load(scope: ArtifactUploadScope, sessionId: string) {
      const rows = await sql.query<SessionRow>(
        `select ${COLUMNS} from artifact_upload_sessions where organization_id = $1 and brand_id = $2 and id = $3 limit 1`,
        [scope.organizationId, scope.brandId, sessionId],
      );
      return rows[0] ? toSession(rows[0]) : null;
    },

    async setSessionUri(scope: ArtifactUploadScope, sessionId: string, sessionUri: string) {
      // Keeps a URI that another process stored first. Its Drive session is then the one this upload continues.
      const rows = await sql.query<{ session_uri: string }>(
        `update artifact_upload_sessions
         set session_uri = case when session_uri = '' then $4 else session_uri end, updated_at = now()
         where organization_id = $1 and brand_id = $2 and id = $3 and status = 'uploading'
         returning session_uri`,
        [scope.organizationId, scope.brandId, sessionId, sessionUri],
      );
      return rows[0]?.session_uri || null;
    },

    async recordProgress(scope, sessionId, progress) {
      await sql.query(
        `update artifact_upload_sessions
         set confirmed_offset = $4, attempts = $5, last_error = $6, updated_at = now()
         where organization_id = $1 and brand_id = $2 and id = $3 and status = 'uploading'`,
        [scope.organizationId, scope.brandId, sessionId, progress.confirmedOffset, progress.attempts, progress.lastError],
      );
    },

    async complete(scope, sessionId, input) {
      if (!sql.begin) throw new Error("This database connection cannot run a transaction, so the upload was not completed.");
      await sql.begin(async (tx) => {
        const rows = await tx.query<{ storage_key: string; mime_type: string; sha256: string; total_bytes: string | number | bigint }>(
          `update artifact_upload_sessions
           set status = 'completed', confirmed_offset = total_bytes, provider_file_id = $4,
               attempts = 0, last_error = null, updated_at = now()
           where organization_id = $1 and brand_id = $2 and id = $3 and status = 'uploading' and session_uri <> ''
           returning storage_key, mime_type, sha256, total_bytes`,
          [scope.organizationId, scope.brandId, sessionId, input.providerFileId],
        );
        if (rows.length === 0) {
          const current = await tx.query<{ status: string }>(
            `select status from artifact_upload_sessions where organization_id = $1 and brand_id = $2 and id = $3`,
            [scope.organizationId, scope.brandId, sessionId],
          );
          if (current[0]?.status === "completed") return;
          throw new Error("The upload session is not active, so it was not completed.");
        }
        const done = rows[0]!;
        if (input.storageObject) {
          await recordStorageObject(tx, scope, sessionId, input.providerFileId, input.storageObject, done);
        }
      });
    },

    async fail(scope, sessionId, input) {
      await sql.query(
        `update artifact_upload_sessions
         set status = 'failed', attempts = $4, last_error = $5, updated_at = now()
         where organization_id = $1 and brand_id = $2 and id = $3 and status = 'uploading'`,
        [scope.organizationId, scope.brandId, sessionId, input.attempts, input.lastError],
      );
    },
  };
}

/**
 * Writes the storage_objects row for a completed upload, and links the session to it. An existing row with the same name
 * and identical bytes is accepted. A row with different bytes is a conflict, and the surrounding transaction rolls back.
 */
async function recordStorageObject(
  tx: Sql,
  scope: ArtifactUploadScope,
  sessionId: string,
  providerFileId: string,
  lifecycle: StorageObjectRecordInput,
  done: { storage_key: string; mime_type: string; sha256: string; total_bytes: string | number | bigint },
): Promise<void> {
  const sizeBytes = Number(done.total_bytes);
  await tx.query(
    `insert into storage_objects (
       id, organization_id, brand_id, provider, provider_file_id, name, mime_type, size_bytes, sha256, lifecycle,
       metadata, created_at, updated_at
     ) values ($1, $2, $3, 'google_drive', $4, $5, $6, $7, $8, $9, $10::jsonb, now(), now())
     on conflict (organization_id, brand_id, name) do nothing`,
    [
      sessionId,
      scope.organizationId,
      scope.brandId,
      providerFileId,
      done.storage_key,
      done.mime_type,
      sizeBytes,
      done.sha256,
      lifecycle.lifecycle,
      JSON.stringify({ key: done.storage_key, fileId: providerFileId }),
    ],
  );
  const stored = await tx.query<{ id: string; mime_type: string; sha256: string; size_bytes: string | number | bigint }>(
    `select id, mime_type, sha256, size_bytes from storage_objects
     where organization_id = $1 and brand_id = $2 and name = $3 limit 1`,
    [scope.organizationId, scope.brandId, done.storage_key],
  );
  const existing = stored[0];
  if (!existing) throw new Error("The storage object row is missing after its insert.");
  if (existing.sha256 !== done.sha256 || Number(existing.size_bytes) !== sizeBytes || existing.mime_type !== done.mime_type) {
    throw new Error("A stored object already exists under this name with different bytes. The upload was not recorded.");
  }
  await tx.query(
    `update artifact_upload_sessions set storage_object_id = $4, updated_at = now()
     where organization_id = $1 and brand_id = $2 and id = $3`,
    [scope.organizationId, scope.brandId, sessionId, existing.id],
  );
}
