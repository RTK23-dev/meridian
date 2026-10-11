import { contentHash } from "../assets/lifecycle.ts";

export const ASSET_LIFECYCLE = [
  "created",
  "uploading",
  "stored",
  "processing",
  "analyzed",
  "approved",
  "rejected",
  "archived",
] as const;

export type AssetLifecycle = (typeof ASSET_LIFECYCLE)[number];

export type StoredObject = {
  key: string;
  organizationId: string;
  brandId: string;
  mimeType: string;
  checksum: string;
  size: number;
  version: number;
  lifecycle: AssetLifecycle;
  bytes: Uint8Array;
};

const MAX_BYTES = 1_500_000;

export function safeStorageKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed || trimmed.includes("..") || trimmed.startsWith("/") || trimmed.includes("\\")) {
    throw new Error("Storage key is not allowed.");
  }
  return trimmed;
}

export function createMemoryObjectStore() {
  const objects = new Map<string, StoredObject & { token: string; tokenExpires: number }>();

  return {
    id: "database" as const,
    put(input: {
      organizationId: string;
      brandId: string;
      key: string;
      mimeType: string;
      bytes: Uint8Array;
      lifecycle?: AssetLifecycle;
    }): StoredObject {
      const key = safeStorageKey(input.key);
      if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_BYTES) {
        throw new Error("Asset is empty or larger than 1.5 MB.");
      }
      const mapKey = `${input.organizationId}:${key}`;
      const previous = objects.get(mapKey);
      const stored = {
        key,
        organizationId: input.organizationId,
        brandId: input.brandId,
        mimeType: input.mimeType,
        checksum: contentHash(Buffer.from(input.bytes).toString("base64")),
        size: input.bytes.byteLength,
        version: (previous?.version ?? 0) + 1,
        lifecycle: input.lifecycle ?? "stored",
        bytes: input.bytes,
        token: "",
        tokenExpires: 0,
      };
      objects.set(mapKey, stored);
      return stored;
    },
    get(organizationId: string, key: string): StoredObject | null {
      const stored = objects.get(`${organizationId}:${safeStorageKey(key)}`);
      if (!stored) return null;
      return stored;
    },
    delete(organizationId: string, key: string) {
      objects.delete(`${organizationId}:${safeStorageKey(key)}`);
    },
    sign(organizationId: string, key: string, now: number, ttlMs: number) {
      const stored = objects.get(`${organizationId}:${safeStorageKey(key)}`);
      if (!stored) return null;
      stored.token = `${stored.checksum}:${now}`;
      stored.tokenExpires = now + ttlMs;
      return { token: stored.token, expires: stored.tokenExpires };
    },
    open(token: string, now: number): StoredObject | null {
      for (const stored of objects.values()) {
        if (stored.token === token && stored.tokenExpires > now) return stored;
      }
      return null;
    },
  };
}

/** External bucket state. Credentials do not mean a successful upload. */
export function externalObjectStorageStatus(env: { bucket?: string; accessKeyId?: string; endpoint?: string; secretAccessKey?: string } = {}): {
  status: "NOT_CONNECTED" | "CONFIGURED";
  detail: string;
} {
  if (!env.endpoint?.trim() || !env.bucket?.trim() || !env.accessKeyId?.trim() || !env.secretAccessKey?.trim()) {
    return {
      status: "NOT_CONNECTED",
      detail: "No S3-compatible endpoint is configured. Development bytes use the local filesystem when that store is selected. Nothing is sent to a bucket.",
    };
  }
  return {
    status: "CONFIGURED",
    detail: "S3 credentials are present. An object is stored only after the bucket accepts the request.",
  };
}

export type StorageObjectRecord = {
  organizationId: string;
  brandId: string;
  key: string;
  providerFileId: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  lifecycle?: AssetLifecycle;
};

export interface StorageMetadataRepository {
  upsert(record: StorageObjectRecord): Promise<void>;
  getByKey(organizationId: string, brandId: string, key: string): Promise<StorageObjectRecord | null>;
}

export function createMemoryStorageMetadataRepository(): StorageMetadataRepository {
  const map = new Map<string, StorageObjectRecord>();
  return {
    async upsert(record: StorageObjectRecord): Promise<void> {
      map.set(`${record.organizationId}:${record.brandId}:${record.key}`, record);
    },
    async getByKey(orgId: string, brandId: string, key: string): Promise<StorageObjectRecord | null> {
      return map.get(`${orgId}:${brandId}:${key}`) || null;
    },
  };
}

export function createSqlStorageMetadataRepository(sql: any): StorageMetadataRepository {
  return {
    async upsert(record: StorageObjectRecord): Promise<void> {
      const id = `${record.organizationId}:${record.brandId}:${record.key}`;
      await sql`
        insert into storage_objects (
          id, organization_id, brand_id, provider, provider_file_id,
          name, mime_type, size_bytes, sha256, lifecycle, metadata, updated_at
        ) values (
          ${id}, ${record.organizationId}, ${record.brandId}, 'google_drive', ${record.providerFileId},
          ${record.key}, ${record.mimeType}, ${record.sizeBytes}, ${record.sha256}, ${record.lifecycle ?? 'stored'},
          ${JSON.stringify({ key: record.key })}, now()
        )
        on conflict (organization_id, brand_id, name) do update set
          provider = excluded.provider,
          provider_file_id = excluded.provider_file_id,
          mime_type = excluded.mime_type,
          size_bytes = excluded.size_bytes,
          sha256 = excluded.sha256,
          lifecycle = excluded.lifecycle,
          metadata = excluded.metadata,
          updated_at = now()
      `;
    },
    async getByKey(orgId: string, brandId: string, key: string): Promise<StorageObjectRecord | null> {
      const rows = await sql`
        select provider_file_id, mime_type, size_bytes, sha256, lifecycle
        from storage_objects
        where organization_id = ${orgId}
          and brand_id = ${brandId}
          and name = ${key}
        limit 1
      `;
      if (!rows.length || !rows[0]) return null;
      const r = rows[0] as any;
      return {
        organizationId: orgId,
        brandId,
        key,
        providerFileId: r.provider_file_id,
        mimeType: r.mime_type,
        sizeBytes: Number(r.size_bytes),
        sha256: r.sha256,
        lifecycle: r.lifecycle as AssetLifecycle,
      };
    },
  };
}

/**
 * Creates the Google Drive backed object store. Drive holds the bytes. The storage_objects row in Postgres is the record of
 * each object, and it is written here after Drive accepts the bytes.
 */
export function createGoogleDriveObjectStore(
  client?: import("./drive.ts").GoogleDriveClient,
  options?: {
    metadataRepo?: StorageMetadataRepository;
    lookupFileId?: (organizationId: string, brandId: string, key: string) => Promise<string | null>;
    recordFileId?: (input: {
      organizationId: string;
      brandId: string;
      key: string;
      fileId: string;
      mimeType: string;
      size: number;
      checksum: string;
    }) => Promise<void>;
  },
) {
  const fileIdMap = new Map<string, string>();
  const repo = options?.metadataRepo || createMemoryStorageMetadataRepository();

  return {
    id: "google_drive" as const,
    async put(input: {
      organizationId: string;
      brandId: string;
      key: string;
      mimeType: string;
      bytes: Uint8Array;
      lifecycle?: AssetLifecycle;
    }): Promise<StoredObject> {
      const drive = client || (await import("./drive.ts")).googleDriveClient;
      const key = safeStorageKey(input.key);
      const res = await drive.put({
        organizationId: input.organizationId,
        brandId: input.brandId,
        path: key,
        mimeType: input.mimeType,
        bytes: input.bytes,
      });

      const mapKey = `${input.organizationId}:${input.brandId}:${key}`;
      fileIdMap.set(mapKey, res.fileId);

      await repo.upsert({
        organizationId: input.organizationId,
        brandId: input.brandId,
        key,
        providerFileId: res.fileId,
        mimeType: res.mimeType,
        sizeBytes: res.size,
        sha256: res.checksum,
        lifecycle: input.lifecycle,
      });

      if (options?.recordFileId) {
        await options.recordFileId({
          organizationId: input.organizationId,
          brandId: input.brandId,
          key,
          fileId: res.fileId,
          mimeType: res.mimeType,
          size: res.size,
          checksum: res.checksum,
        });
      }

      return {
        key,
        organizationId: input.organizationId,
        brandId: input.brandId,
        mimeType: res.mimeType,
        checksum: res.checksum,
        size: res.size,
        version: 1,
        lifecycle: input.lifecycle ?? "stored",
        bytes: input.bytes,
      };
    },
    async get(organizationId: string, brandId: string, key: string): Promise<StoredObject | null> {
      const drive = client || (await import("./drive.ts")).googleDriveClient;
      const cleanKey = safeStorageKey(key);
      const mapKey = `${organizationId}:${brandId}:${cleanKey}`;

      // Step 1: Resolve provider_file_id from in-memory map or metadata repository
      let fileId = fileIdMap.get(mapKey);
      if (!fileId) {
        const meta = await repo.getByKey(organizationId, brandId, cleanKey);
        if (meta) {
          fileId = meta.providerFileId;
        }
      }
      if (!fileId && options?.lookupFileId) {
        fileId = (await options.lookupFileId(organizationId, brandId, cleanKey)) || undefined;
      }

      // Step 2: Recovery only. When Postgres has no row for this key, the file is looked up by name under its folder. Postgres
      // is the index; this path exists for bytes whose row was never recorded.
      if (!fileId) {
        try {
          const pathParts = cleanKey.split("/").filter(Boolean);
          const fileName = pathParts.pop();
          if (fileName) {
            const folderId = await drive.getFolderForPath({
              organizationId,
              brandId,
              subpath: pathParts.join("/"),
            });
            fileId = (await drive.findFileByName(folderId, fileName)) || undefined;
          }
        } catch {
          // Folder navigation fallback not available or failed
        }
      }

      if (!fileId) {
        return null;
      }

      try {
        const file = await drive.get(fileId);
        return {
          key: cleanKey,
          organizationId,
          brandId,
          mimeType: file.mimeType,
          checksum: contentHash(Buffer.from(file.bytes).toString("base64")),
          size: file.bytes.byteLength,
          version: 1,
          lifecycle: "stored",
          bytes: file.bytes,
        };
      } catch {
        return null;
      }
    },
    async delete(fileId: string): Promise<void> {
      const drive = client || (await import("./drive.ts")).googleDriveClient;
      await drive.delete(fileId);
    },
  };
}

