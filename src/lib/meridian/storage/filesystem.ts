import { createHmac, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ASSET_LIFECYCLE, safeStorageKey, type AssetLifecycle } from "./object-store.ts";

export type ObjectMeta = {
  key: string;
  organizationId: string;
  brandId: string;
  mimeType: string;
  checksum: string;
  size: number;
  version: number;
  lifecycle: AssetLifecycle;
};

type Sidecar = ObjectMeta & { token: string; tokenExpires: number };

const MAX_BYTES = 8_000_000;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createFilesystemObjectStore(root: string, secret = "meridian-dev-object-secret") {
  const base = resolve(root);
  mkdirSync(base, { recursive: true });

  const pathFor = (organizationId: string, key: string) => {
    const safe = safeStorageKey(key);
    const full = resolve(base, organizationId, safe);
    const fromBase = relative(base, full);
    if (fromBase === ".." || fromBase.startsWith(`..${sep}`) || isAbsolute(fromBase)) {
      throw new Error("Storage key is not allowed.");
    }
    return full;
  };

  return {
    id: "filesystem" as const,
    put(input: {
      organizationId: string;
      brandId: string;
      key: string;
      mimeType: string;
      bytes: Uint8Array;
      lifecycle?: AssetLifecycle;
    }): ObjectMeta {
      if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_BYTES) {
        throw new Error("Asset is empty or larger than 8 MB.");
      }
      const lifecycle = input.lifecycle ?? "stored";
      if (!ASSET_LIFECYCLE.includes(lifecycle)) throw new Error("Unknown asset lifecycle.");
      const full = pathFor(input.organizationId, input.key);
      const metaPath = `${full}.meta.json`;
      const previous = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, "utf8")) as Sidecar) : null;
      const meta: Sidecar = {
        key: safeStorageKey(input.key),
        organizationId: input.organizationId,
        brandId: input.brandId,
        mimeType: input.mimeType,
        checksum: sha256(input.bytes),
        size: input.bytes.byteLength,
        version: (previous?.version ?? 0) + 1,
        lifecycle,
        token: "",
        tokenExpires: 0,
      };
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, input.bytes);
      writeFileSync(metaPath, JSON.stringify(meta));
      return meta;
    },
    get(organizationId: string, key: string): (ObjectMeta & { bytes: Uint8Array }) | null {
      const full = pathFor(organizationId, key);
      if (!existsSync(full)) return null;
      const meta = JSON.parse(readFileSync(`${full}.meta.json`, "utf8")) as Sidecar;
      if (meta.organizationId !== organizationId) return null;
      return { ...meta, bytes: new Uint8Array(readFileSync(full)) };
    },
    delete(organizationId: string, key: string) {
      const full = pathFor(organizationId, key);
      rmSync(full, { force: true });
      rmSync(`${full}.meta.json`, { force: true });
    },
    exists(organizationId: string, key: string): boolean {
      return existsSync(pathFor(organizationId, key));
    },
    metadata(organizationId: string, key: string): ObjectMeta | null {
      const full = pathFor(organizationId, key);
      if (!existsSync(`${full}.meta.json`)) return null;
      const meta = JSON.parse(readFileSync(`${full}.meta.json`, "utf8")) as Sidecar;
      if (meta.organizationId !== organizationId) return null;
      return meta;
    },
    signedUrl(organizationId: string, key: string, now: number, ttlMs: number): string | null {
      const full = pathFor(organizationId, key);
      if (!existsSync(`${full}.meta.json`)) return null;
      const meta = JSON.parse(readFileSync(`${full}.meta.json`, "utf8")) as Sidecar;
      const token = createHmac("sha256", secret)
        .update(`${organizationId}:${meta.key}:${now}:${randomBytes(8).toString("hex")}`)
        .digest("hex");
      meta.token = token;
      meta.tokenExpires = now + ttlMs;
      writeFileSync(`${full}.meta.json`, JSON.stringify(meta));
      return `/api/assets/open?token=${token}`;
    },
    open(token: string, now: number): (ObjectMeta & { bytes: Uint8Array }) | null {
      return walk(base, (meta, full) => {
        if (meta.token !== token || meta.tokenExpires <= now) return null;
        const bytes = new Uint8Array(readFileSync(full));
        if (statSync(full).size !== meta.size) return null;
        return { ...meta, bytes };
      });
    },
  };
}

function walk(
  directory: string,
  visit: (meta: Sidecar, file: string) => (ObjectMeta & { bytes: Uint8Array }) | null,
): (ObjectMeta & { bytes: Uint8Array }) | null {
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = walk(full, visit);
      if (found) return found;
    } else if (entry.name.endsWith(".meta.json")) {
      const meta = JSON.parse(readFileSync(full, "utf8")) as Sidecar;
      const file = full.slice(0, -".meta.json".length);
      const found = visit(meta, file);
      if (found) return found;
    }
  }
  return null;
}

export function migrateBlob(
  store: ReturnType<typeof createFilesystemObjectStore>,
  blob: { organizationId: string; brandId: string; key: string; mimeType: string; base64: string },
): ObjectMeta {
  return store.put({ ...blob, bytes: Buffer.from(blob.base64, "base64") });
}
