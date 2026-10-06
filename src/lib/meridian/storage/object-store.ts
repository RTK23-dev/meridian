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

/** External object storage is not configured in this deployment. */
export function externalObjectStorageStatus(env: { bucket?: string; accessKeyId?: string }): {
  status: "NOT_CONNECTED";
  detail: string;
} {
  if (!env.bucket || !env.accessKeyId) {
    return {
      status: "NOT_CONNECTED",
      detail: "No S3-compatible bucket is configured. Bytes are stored in the application database, not a fake bucket.",
    };
  }
  return {
    status: "NOT_CONNECTED",
    detail: "Bucket credentials are present, but this build does not upload to S3. Nothing was sent.",
  };
}
