/**
 * The asset router's store for image bytes, in Meridian's engine object store (Bible 5.2, 10.1). The router writes a finished image
 * through a MediaStore that takes the workspace and the bytes. This adapter is made for one request's scope (the organization and the
 * request), because an engine key names its request (engine/{workspaceId}/{requestId}/{stage}/{artifactId}.{ext}) and the signed link
 * reads the object's brand from that request (engine-media-link.ts). The bytes are stored under the request's brand.
 *
 * Rules:
 *   - The organization is the scope's. A write or a read for another workspace is refused before anything is sent (the workspace id
 *     comes from the caller, the router, and never from the bytes or the key).
 *   - The key is content-addressed: its name is the sha256 of the bytes, and the caller's content hash must match it. The same bytes
 *     under the same request are one object; the store's put is idempotent for identical content.
 *   - Only the engine's own media types are stored (png, mp4, wav). Anything else, such as the mp3 of speech, is refused with its
 *     reason, because the engine's keys carry no other extension (the voice stage's storage is decided separately).
 *   - No S3 and no vendor SDK: the bytes go to the object store the caller passes (Google Drive, through engineObjectStore).
 *
 * Structurally the engine's MediaStore (src/engine/assets/adapter.ts). The engine never imports this file, so the dependency points one
 * way. Nothing here logs the bytes, the key's secrets or the brand's contents.
 */
import { createHash } from "node:crypto";
import { isEngineMediaKey } from "./engine-media-link.ts";

/** The request whose media is stored: the organization the caller is in, and the request the bytes belong to. */
export type EngineAssetScope = { organizationId: string; requestId: string };

/** The object store the adapter writes to. Meridian's engineObjectStore satisfies it (artifact-store.ts MediaStorePort). */
export type EngineAssetObjects = {
  put(input: { organizationId: string; brandId: string; key: string; mimeType: string; bytes: Uint8Array }): Promise<unknown>;
  get(organizationId: string, brandId: string, key: string): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
};

export type EngineAssetMediaInput = {
  objects: EngineAssetObjects;
  /** The brand a request's media is stored under (Bible 5.2). It throws when the request has no brand, so nothing is stored. */
  brandOf: (scope: EngineAssetScope) => Promise<string>;
};

/** The router's MediaStore shape (src/engine/assets/adapter.ts), plus the read the adapter also offers. */
export type EngineAssetMediaStore = {
  put(input: { workspaceId: string; bytes: Uint8Array; mediaType: string; contentHash: string }): Promise<{ uri: string }>;
  read(input: { workspaceId: string; uri: string }): Promise<{ bytes: Uint8Array; mediaType: string } | null>;
};

/** The stage segment of the keys this adapter writes. The router does not name a stage, so the adapter's own is fixed. */
export const ASSET_STAGE = "assets";

const SAFE_PART = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** The engine's media types, and the extension each one is stored under (the engine's MEDIA_MIME_TYPES, artifact-store.ts). */
const EXTENSION_BY_MEDIA_TYPE: Readonly<Record<string, "png" | "mp4" | "wav">> = {
  "image/png": "png",
  "video/mp4": "mp4",
  "audio/wav": "wav",
};

/** The key of one stored asset: engine/{organization}/{request}/assets/{sha256 hex}.{ext}. Every part follows the engine's rule. */
export function engineAssetKey(scope: EngineAssetScope, digestHex: string, extension: "png" | "mp4" | "wav"): string {
  const parts = [scope.organizationId, scope.requestId, ASSET_STAGE, digestHex];
  for (const part of parts) {
    if (!SAFE_PART.test(part) || part.includes("..")) throw new Error("the asset key has a part the engine does not allow");
  }
  return `engine/${scope.organizationId}/${scope.requestId}/${ASSET_STAGE}/${digestHex}.${extension}`;
}

/** The request id a key of this organization names (its third part), or null when the key is not one of its engine media keys. */
function requestOfKey(organizationId: string, key: string): string | null {
  if (!isEngineMediaKey(organizationId, key)) return null;
  return key.split("/")[2] ?? null;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The asset store of one request. It writes and reads only inside the scope's organization; a uri of another organization is refused
 * before the object store is touched.
 */
export function engineAssetMediaFor(input: EngineAssetMediaInput, scope: EngineAssetScope): EngineAssetMediaStore {
  return {
    async put(request) {
      if (request.workspaceId !== scope.organizationId) {
        throw new Error("the asset store refuses a write for another workspace; nothing was stored");
      }
      const extension = EXTENSION_BY_MEDIA_TYPE[request.mediaType];
      if (extension === undefined) {
        throw new Error(`the engine stores png, mp4 and wav objects, not ${request.mediaType}; nothing was stored`);
      }
      if (request.bytes.byteLength === 0) throw new Error("the asset is empty; nothing was stored");
      const digest = sha256Hex(request.bytes);
      if (request.contentHash !== `sha256:${digest}`) {
        throw new Error("the bytes do not match their content hash; nothing was stored");
      }
      const key = engineAssetKey(scope, digest, extension);
      const brandId = await input.brandOf(scope);
      await input.objects.put({ organizationId: scope.organizationId, brandId, key, mimeType: request.mediaType, bytes: request.bytes });
      return { uri: key };
    },

    async read(request) {
      const requestId = requestOfKey(request.workspaceId, request.uri);
      if (requestId === null) {
        throw new Error("the asset store refuses a key outside its workspace; nothing was read");
      }
      const brandId = await input.brandOf({ organizationId: request.workspaceId, requestId });
      const object = await input.objects.get(request.workspaceId, brandId, request.uri);
      return object === null ? null : { bytes: object.bytes, mediaType: object.mimeType };
    },
  };
}
