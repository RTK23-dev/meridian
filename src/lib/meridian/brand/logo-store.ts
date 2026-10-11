/**
 * Stores a brand logo so that the asset route can serve it. The bytes go to asset_blobs under the storage key the asset row
 * names, with the SHA-256 and length the asset route checks before it serves anything. Plain SQL with a node crypto import,
 * so it can be tested directly on PGlite and PostgreSQL.
 */
import { createHash } from "node:crypto";
import type { Sql } from "../learning/store.ts";

export function logoStorageKey(brandId: string, contentHashValue: string): string {
  return `brand/${brandId}/logo/${contentHashValue}`;
}

export async function persistBrandLogo(
  sql: Sql,
  input: {
    organizationId: string;
    brandId: string;
    assetId: string;
    base64: string;
    bytes: Uint8Array;
    mime: string;
    contentHashValue: string;
  },
): Promise<{ storageKey: string; checksum: string }> {
  const storageKey = logoStorageKey(input.brandId, input.contentHashValue);
  const checksum = createHash("sha256").update(input.bytes).digest("hex");
  // The bytes first, so the asset row never points at a file the asset route cannot find.
  await sql`
    insert into asset_blobs (storage_key, organization_id, brand_id, body, mime_type, checksum, byte_size, version, lifecycle)
    values (${storageKey}, ${input.organizationId}, ${input.brandId}, ${input.base64}, ${input.mime}, ${checksum}, ${input.bytes.byteLength}, 1, 'stored')
    on conflict (storage_key) do nothing
  `;
  await sql`
    insert into assets (id, organization_id, brand_id, version, storage_key, content_hash, mime_type, source, status, body, byte_size, label, checksum)
    values (
      ${input.assetId}, ${input.organizationId}, ${input.brandId}, 1, ${storageKey},
      ${input.contentHashValue}, ${input.mime}, 'logo_upload', 'stored', ${input.base64}, ${input.bytes.byteLength}, 'logo', ${checksum}
    )
  `;
  return { storageKey, checksum };
}
