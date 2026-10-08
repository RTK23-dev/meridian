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

/**
 * Creates Google Drive backed object store.
 * Drive is the primary binary storage target for Meridian.
 */
export function createGoogleDriveObjectStore(client?: import("./drive.ts").GoogleDriveClient) {
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
      try {
        const file = await drive.get(safeStorageKey(key));
        return {
          key,
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

