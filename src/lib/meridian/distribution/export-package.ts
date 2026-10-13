/**
 * The export package for one creative (ARCHITECTURE_CONTRACTS 4.2 and 7.2). It is the set of files a person posts by hand, listed by
 * the Postgres rows that hold them. It depends on no channel and no connection: a creative that no channel took, or that is not
 * approved, still has its package, so the manual route is always there.
 *
 * This build writes the listing only. It does not copy the files to Google Drive, and no route serves it yet. The files are the
 * creative's stored assets, read back as they are recorded.
 */
import type { Sql } from "../learning/store.ts";

export type ExportPackageFile = {
  assetId: string;
  storageKey: string;
  mimeType: string;
  sha256: string;
  byteSize: number | null;
  kind: string;
};

export type ExportPackage = {
  creativeId: string;
  title: string;
  /** The copy the creative carries, as stored. Untrusted text from a model or a person: it is shown as text, never as markup. */
  copy: string;
  format: string;
  creativeStatus: string;
  files: ExportPackageFile[];
};

/** The package for one creative in this tenant, or null when the creative is not in it. A creative with no stored file has no files. */
export async function buildExportPackage(
  sql: Sql,
  scope: { organizationId: string; brandId: string },
  creativeId: string,
): Promise<ExportPackage | null> {
  const creatives = await sql<{ id: string; title: string; raw_text: string; format: string; status: string }>`
    select id, title, raw_text, format, status from creative_records
    where id = ${creativeId} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
    limit 1
  `;
  const creative = creatives[0];
  if (!creative) return null;
  const assets = await sql<{ id: string; storage_key: string; mime_type: string; checksum: string; byte_size: number | null; kind: string }>`
    select id, storage_key, mime_type, checksum, byte_size, kind from assets
    where creative_id = ${creative.id} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
    order by variant_index asc, id asc
  `;
  return {
    creativeId: creative.id,
    title: creative.title,
    copy: creative.raw_text,
    format: creative.format,
    creativeStatus: creative.status,
    files: assets.map((asset) => ({
      assetId: asset.id,
      storageKey: asset.storage_key,
      mimeType: asset.mime_type,
      sha256: asset.checksum,
      byteSize: asset.byte_size == null ? null : Number(asset.byte_size),
      kind: asset.kind,
    })),
  };
}
