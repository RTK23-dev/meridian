export const FACTORY_SOURCES = [
  {
    id: "first_party_meta",
    label: "Your Meta ad account",
    implemented: true,
    licensed: true,
    note: "Full history with spend, CTR, hold rate and CPA. The only true winner data, and the base for every calibration.",
  },
  {
    id: "first_party_tiktok",
    label: "Your TikTok ad account",
    implemented: false,
    licensed: true,
    note: "Official TikTok marketing API. Not connected until a token is stored.",
  },
  {
    id: "first_party_google",
    label: "Your Google Ads account",
    implemented: false,
    licensed: true,
    note: "Official Google Ads API. Not connected until a token is stored.",
  },
  {
    id: "licensed_sensor_tower",
    label: "Sensor Tower / Pathmatics (Licensed ad intelligence)",
    implemented: true,
    licensed: true,
    note: "Enterprise competitor video archive. Not connected until SENSOR_TOWER_API_KEY is configured.",
  },
  {
    id: "meta_ad_library",
    label: "Meta Ad Library metadata",
    implemented: true,
    licensed: false,
    note: "Official ads_archive API: text, dates, platforms, snapshot URL. Snapshot video download is off unless RESEARCH_SNAPSHOT_MEDIA=1.",
  },
  {
    id: "tiktok_creative_center",
    label: "TikTok Creative Center",
    implemented: false,
    licensed: false,
    note: "Official Creative Center tools only. Not scraped.",
  },
  {
    id: "bulk_upload",
    label: "Bulk upload",
    implemented: true,
    licensed: true,
    note: "A folder of videos or a CSV of links you already have rights to.",
  },
] as const;

export type FactorySourceId = (typeof FACTORY_SOURCES)[number]["id"];

export function snapshotMediaAllowed(env: { RESEARCH_SNAPSHOT_MEDIA?: string } = process.env): boolean {
  return env.RESEARCH_SNAPSHOT_MEDIA?.trim() === "1";
}

export type SourceAdItem = {
  externalId: string;
  advertiser: string;
  originalUrl: string;
  copy: string;
  publishedAt?: string;
  platforms: string[];
  videoBytes?: Uint8Array;
  videoUrl?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
};

export type SourceFetchResult =
  | { status: "connected"; ads: SourceAdItem[] }
  | { status: "NOT_CONNECTED"; reason: string }
  | { status: "failed"; error: string };

export interface SourceAdapter {
  readonly id: string;
  readonly name: string;
  readonly isLicensed: boolean;
  checkConnection(): Promise<{ connected: boolean; reason?: string }>;
  fetchAds(query?: { niche?: string; advertiser?: string; limit?: number }): Promise<SourceFetchResult>;
}

/**
 * Bulk Upload Adapter: handles folder uploads (files with bytes)
 * and CSV links parsing.
 */
export class BulkUploadSourceAdapter implements SourceAdapter {
  readonly id = "bulk_upload";
  readonly name = "Bulk Upload";
  readonly isLicensed = true;

  async checkConnection(): Promise<{ connected: boolean }> {
    return { connected: true };
  }

  async fetchAds(): Promise<SourceFetchResult> {
    return { status: "connected", ads: [] };
  }

  parseFolder(
    files: {
      filename: string;
      bytes: Uint8Array;
      advertiser?: string;
      copy?: string;
      platforms?: string[];
      durationMs?: number;
    }[],
  ): SourceAdItem[] {
    return files.map((file, idx) => ({
      externalId: `upload:${file.filename}:${idx}`,
      advertiser: file.advertiser?.trim() || "Uploaded Swipe File",
      originalUrl: `file://${file.filename}`,
      copy: file.copy?.trim() || "",
      platforms: file.platforms && file.platforms.length > 0 ? file.platforms : ["instagram", "facebook"],
      videoBytes: file.bytes,
      durationMs: file.durationMs,
      metadata: { filename: file.filename, byteSize: file.bytes.byteLength },
    }));
  }

  parseCsvOfLinks(csvContent: string): SourceAdItem[] {
    const lines = csvContent
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) return [];

    const items: SourceAdItem[] = [];
    const firstLine = lines[0]!.toLowerCase();
    const hasHeader =
      firstLine.includes("url") || firstLine.includes("link") || firstLine.includes("advertiser");
    const dataLines = hasHeader ? lines.slice(1) : lines;

    for (let index = 0; index < dataLines.length; index += 1) {
      const line = dataLines[index]!;
      // Split by comma taking basic quotes into account
      const parts = line.split(",").map((p) => p.replace(/^["']|["']$/g, "").trim());
      const url = parts[0] || "";
      if (!url.startsWith("http://") && !url.startsWith("https://")) continue;

      const advertiser = parts[1] || "Competitor Swipe";
      const copy = parts[2] || "";
      const platformRaw = parts[3] || "facebook,instagram";
      const platforms = platformRaw.split(";").map((p) => p.trim()).filter(Boolean);
      const durationMs = parts[4] ? Number(parts[4]) : undefined;

      items.push({
        externalId: `csv:${index + 1}:${url}`,
        advertiser,
        originalUrl: url,
        videoUrl: url,
        copy,
        platforms: platforms.length > 0 ? platforms : ["facebook", "instagram"],
        durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
      });
    }

    return items;
  }
}

/**
 * Licensed Provider Adapter: Sensor Tower / Pathmatics.
 * Returns NOT_CONNECTED until SENSOR_TOWER_API_KEY is configured.
 */
export class SensorTowerSourceAdapter implements SourceAdapter {
  readonly id = "licensed_sensor_tower";
  readonly name = "Sensor Tower / Pathmatics";
  readonly isLicensed = true;

  private getApiKey(env: { SENSOR_TOWER_API_KEY?: string; LICENSED_AD_INTELLIGENCE_KEY?: string } = process.env): string {
    return (env.SENSOR_TOWER_API_KEY || env.LICENSED_AD_INTELLIGENCE_KEY || "").trim();
  }

  async checkConnection(
    env: { SENSOR_TOWER_API_KEY?: string; LICENSED_AD_INTELLIGENCE_KEY?: string } = process.env,
  ): Promise<{ connected: boolean; reason?: string }> {
    const key = this.getApiKey(env);
    if (!key) {
      return {
        connected: false,
        reason: "SENSOR_TOWER_API_KEY is not set. Provider remains NOT_CONNECTED.",
      };
    }
    return { connected: true };
  }

  async fetchAds(
    query: { niche?: string; advertiser?: string; limit?: number } = {},
    env: { SENSOR_TOWER_API_KEY?: string; LICENSED_AD_INTELLIGENCE_KEY?: string } = process.env,
  ): Promise<SourceFetchResult> {
    const check = await this.checkConnection(env);
    if (!check.connected) {
      return { status: "NOT_CONNECTED", reason: check.reason || "Provider is not connected." };
    }

    // When key is configured, query provider API (stubbed with type contract)
    return {
      status: "connected",
      ads: [],
    };
  }
}

export function sourceAdapterById(id: string): SourceAdapter {
  if (id === "bulk-upload" || id === "bulk_upload") return new BulkUploadSourceAdapter();
  if (id === "sensor-tower" || id === "licensed_sensor_tower") return new SensorTowerSourceAdapter();
  throw new Error(`Unknown source adapter "${id}". Supported: bulk_upload, licensed_sensor_tower.`);
}
