/**
 * Upload Source Adapter
 *
 * Ingests user-uploaded media files or link manifests already owned/authorized by the tenant.
 */

import { createHash } from "node:crypto";
import type {
  SourceAdapter,
  SourceCapabilities,
  SourceReference,
  RawArtifact,
  SourceHealth,
  DiscoveryQuery,
} from "../types.ts";

export class UploadSourceAdapter implements SourceAdapter {
  readonly id = "upload";
  readonly platform = "upload" as const;
  readonly capabilities: SourceCapabilities = {
    profileDiscovery: false,
    contentDiscovery: true,
    metadata: true,
    videos: true,
    images: true,
    comments: false,
    performance: false,
    webpages: false,
    search: false,
  };

  async discover(_query: DiscoveryQuery): Promise<SourceReference[]> {
    return [];
  }

  async fetch(reference: SourceReference): Promise<RawArtifact> {
    const bytes = (reference.metadata?.bytes as Uint8Array) || new Uint8Array();
    const sha256 = bytes.byteLength > 0 ? createHash("sha256").update(bytes).digest("hex") : undefined;

    return {
      id: reference.sourceId,
      reference,
      type: reference.metadata?.type === "image" ? "image" : "video",
      bytes,
      mimeType: (reference.metadata?.mimeType as string) || "video/mp4",
      sha256,
      capturedAt: new Date().toISOString(),
    };
  }

  async health(): Promise<SourceHealth> {
    return {
      adapterId: this.id,
      status: "HEALTHY",
      latencyMs: 1,
      message: "Ready for local files and URL uploads.",
      lastCheckedAt: new Date().toISOString(),
    };
  }
}
