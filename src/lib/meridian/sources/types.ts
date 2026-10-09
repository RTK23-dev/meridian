/**
 * Universal Source Fabric Types
 *
 * Capability-based source adapter contracts replacing narrow fetchAds() models.
 */

export type SourceKind =
  | "instagram"
  | "tiktok"
  | "youtube"
  | "twitter"
  | "threads"
  | "facebook"
  | "pinterest"
  | "reddit"
  | "linkedin"
  | "meta_ad_library"
  | "website"
  | "search"
  | "upload"
  | "licensed"
  | "first_party_analytics";

export type EvidenceAvailability =
  | "REFERENCE_ONLY"
  | "METADATA_AVAILABLE"
  | "MEDIA_AVAILABLE"
  | "FULL_EVIDENCE_AVAILABLE";

export type SourceCapabilities = {
  profileDiscovery: boolean;
  contentDiscovery: boolean;
  metadata: boolean;
  videos: boolean;
  images: boolean;
  comments: boolean;
  performance: boolean;
  webpages: boolean;
  search: boolean;
  mediaDownload?: boolean;
  pagination?: boolean;
};

export type SourceReference = {
  sourceId: string;
  platform: SourceKind;
  externalId?: string | null;
  canonicalUrl?: string | null;
  sourceAdapter: string;
  discoveredAt: string;
  capturedAt?: string;
  evidenceAvailability?: EvidenceAvailability;
  metadata?: Record<string, unknown>;
};

export type RawArtifact = {
  id: string;
  reference: SourceReference;
  type: "video" | "image" | "html" | "json" | "document";
  bytes?: Uint8Array;
  mimeType: string;
  sha256?: string;
  textPayload?: string;
  jsonPayload?: Record<string, unknown>;
  evidenceAvailability?: EvidenceAvailability;
  capturedAt: string;
};

export type SourceSnapshot = {
  sourceId: string;
  platform: SourceKind;
  metrics: {
    views?: number;
    likes?: number;
    comments?: number;
    shares?: number;
    saves?: number;
    reach?: number;
  };
  capturedAt: string;
};

export type SourceHealth = {
  adapterId: string;
  status: "HEALTHY" | "DEGRADED" | "NOT_CONFIGURED" | "UNAVAILABLE" | "CONFIGURED" | "AUTH_FAILED" | "RATE_LIMITED";
  latencyMs: number;
  message?: string;
  lastCheckedAt: string;
};

export type DiscoveryQuery = {
  niche?: string;
  query?: string;
  creatorHandle?: string;
  advertiser?: string;
  limit?: number;
  since?: string;
};

export interface SourceAdapter {
  readonly id: string;
  readonly platform: SourceKind;
  readonly capabilities: SourceCapabilities;

  discover(query: DiscoveryQuery): Promise<SourceReference[]>;
  fetch(reference: SourceReference): Promise<RawArtifact>;
  snapshot?(reference: SourceReference): Promise<SourceSnapshot>;
  health(): Promise<SourceHealth>;
}
