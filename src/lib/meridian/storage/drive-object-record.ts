/**
 * The storage_objects row for a file written to Google Drive. Drive holds the bytes. This row is the record of the file: its
 * organization, brand, object key, bytes, sha256, Drive file id, and the time it was recorded (created_at).
 *
 * One row per (organization, brand, object key). Recording the same file again changes nothing. A different file under the
 * same key is a conflict, and it is refused rather than overwritten. The caller records a row only after Drive has accepted
 * the bytes, so a failed Drive write never leaves a row that points at nothing.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import type { AssetLifecycle } from "./object-store.ts";

export type DriveObjectRecord = {
  organizationId: string;
  brandId: string;
  /** The object key: the path the file was written under. */
  key: string;
  fileId: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  lifecycle: AssetLifecycle;
};

export async function recordDriveObject(sql: Sql, record: DriveObjectRecord): Promise<{ id: string; created: boolean }> {
  const inserted = await sql<{ id: string }>`
    insert into storage_objects (
      id, organization_id, brand_id, provider, provider_file_id, name, mime_type, size_bytes, sha256, lifecycle,
      metadata, created_at, updated_at
    ) values (
      ${`sobj_${randomUUID()}`}, ${record.organizationId}, ${record.brandId}, 'google_drive', ${record.fileId}, ${record.key},
      ${record.mimeType}, ${record.sizeBytes}, ${record.sha256}, ${record.lifecycle},
      ${JSON.stringify({ key: record.key, fileId: record.fileId })}::jsonb, now(), now()
    )
    on conflict (organization_id, brand_id, name) do nothing
    returning id
  `;
  const rows = await sql<{ id: string; provider_file_id: string; mime_type: string; size_bytes: string | number | bigint; sha256: string }>`
    select id, provider_file_id, mime_type, size_bytes, sha256 from storage_objects
    where organization_id = ${record.organizationId} and brand_id = ${record.brandId} and name = ${record.key}
    limit 1
  `;
  const row = rows[0];
  if (!row) throw new Error("The storage object row is missing after its insert.");
  if (
    row.provider_file_id !== record.fileId ||
    row.sha256 !== record.sha256 ||
    Number(row.size_bytes) !== record.sizeBytes ||
    row.mime_type !== record.mimeType
  ) {
    throw new Error("A stored object already exists under this key with a different file or different bytes. The new file was not recorded.");
  }
  return { id: row.id, created: inserted.length === 1 };
}
