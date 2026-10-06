import { contentHash } from "../assets/lifecycle.ts";

export type RawMarketRecord = {
  id: string;
  organizationId: string;
  brandId: string;
  source: string;
  externalId: string;
  url: string;
  collectedAt: number;
  publishedAt: number | null;
  advertiser: string;
  platform: string;
  mediaType: string;
  text: string;
  angle: string;
  hook: string;
};

export type NormalizedCreative = {
  fingerprint: string;
  origin: "competitor";
  advertiser: string;
  platform: string;
  mediaType: string;
  text: string;
  angle: string;
  hook: string;
  provenance: "OBSERVED" | "USER_CONFIRMED";
  source: string;
  externalId: string;
  url: string;
};

export function fingerprintRecord(record: Pick<RawMarketRecord, "source" | "externalId" | "text" | "advertiser">): string {
  const identity = record.externalId.trim() || record.text.trim();
  return contentHash(`${record.source}|${record.advertiser}|${identity}`);
}

export function normalizeRecord(record: RawMarketRecord): { ok: true; creative: NormalizedCreative } | { ok: false; error: string } {
  if (!record.text.trim()) return { ok: false, error: "The source record has no creative text." };
  if (!record.advertiser.trim()) return { ok: false, error: "The source record has no advertiser." };
  return {
    ok: true,
    creative: {
      fingerprint: fingerprintRecord(record),
      origin: "competitor",
      advertiser: record.advertiser.trim(),
      platform: record.platform.trim(),
      mediaType: record.mediaType.trim(),
      text: record.text.trim(),
      angle: record.angle.trim(),
      hook: record.hook.trim() || record.text.trim().split(/[.\n]/)[0]?.trim() || "",
      provenance: record.angle.trim() ? "USER_CONFIRMED" : "OBSERVED",
      source: record.source,
      externalId: record.externalId,
      url: record.url,
    },
  };
}

export function dedupeCreatives(creatives: NormalizedCreative[]): { kept: NormalizedCreative[]; duplicates: string[] } {
  const seen = new Set<string>();
  const kept: NormalizedCreative[] = [];
  const duplicates: string[] = [];
  for (const creative of creatives) {
    if (seen.has(creative.fingerprint)) {
      duplicates.push(creative.fingerprint);
      continue;
    }
    seen.add(creative.fingerprint);
    kept.push(creative);
  }
  return { kept, duplicates };
}

/** No ad library is connected. This must not invent records. */
export function collectAdLibrarySource(): { status: "NOT_CONNECTED"; records: RawMarketRecord[]; detail: string } {
  return {
    status: "NOT_CONNECTED",
    records: [],
    detail: "No ad-library source is connected. No ads were collected.",
  };
}
