/**
 * The binary store that artifacts are written to. Google Drive is the real backend. In the testing runtime, and only there,
 * an in-memory store stands in for it, so the artifact path runs end to end without Google credentials. Production never
 * selects the in-memory store.
 */
import { createHash } from "node:crypto";
import { isTestingRuntimeNow } from "../runtime-mode.ts";
import { googleDriveClient, type DriveFileMetadata, type GoogleDriveClient } from "./drive.ts";

/** The part of the Drive client that artifact storage uses. */
export type ArtifactDrive = Pick<GoogleDriveClient, "put" | "get">;

const testStore = new Map<string, { bytes: Uint8Array; mimeType: string; name: string }>();

const memoryDrive: ArtifactDrive = {
  async put(input): Promise<DriveFileMetadata> {
    const fileId = `memory:${input.organizationId}:${input.brandId}:${input.path}`;
    const existing = testStore.get(fileId);
    if (existing && (existing.bytes.byteLength !== input.bytes.byteLength || existing.mimeType !== input.mimeType)) {
      throw new Error("Test artifact store already holds a different object under this key.");
    }
    testStore.set(fileId, { bytes: new Uint8Array(input.bytes), mimeType: input.mimeType, name: input.path });
    return {
      fileId,
      name: input.path,
      mimeType: input.mimeType,
      size: input.bytes.byteLength,
      checksum: createHash("sha256").update(input.bytes).digest("hex"),
    };
  },
  async get(fileId: string) {
    const stored = testStore.get(fileId);
    if (!stored) throw new Error(`Test artifact store has no object '${fileId}'.`);
    return { bytes: new Uint8Array(stored.bytes), mimeType: stored.mimeType, name: stored.name };
  },
};

/** The store artifacts are written to right now: Google Drive, or the in-memory double in the testing runtime. */
export function defaultArtifactDrive(): ArtifactDrive {
  return isTestingRuntimeNow() ? memoryDrive : googleDriveClient;
}
