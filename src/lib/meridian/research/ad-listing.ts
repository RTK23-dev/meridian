/**
 * The research ads for one brand, as the market screen reads them. Plain SQL with no server-function imports, so the
 * listing can be tested directly on PGlite and PostgreSQL.
 */
import type { Sql } from "../learning/store.ts";

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function loadResearchAds(sql: Sql, organizationId: string, brandId: string) {
  const rows = await sql<Record<string, unknown>>`
    select a.id, a.external_id, a.advertiser, a.original_url, a.captured_at, a.published_at, a.copy, a.headline,
      a.description, a.media_type, a.media_status, a.media_storage_key, a.media_bytes, a.media_duration_ms,
      a.transcript_status, a.analysis_status, a.last_error, a.creative_id, t.transcript, t.segments,
      r.result as analysis, r.confidence, r.review_required, r.provider, r.model, r.schema_version,
      (select s.id from assets s
        where a.media_storage_key <> '' and s.storage_key = a.media_storage_key
          and s.organization_id = a.organization_id and s.brand_id = a.brand_id and s.status = 'stored'
        order by s.created_at asc limit 1) as media_asset_id
    from research_ads a
    left join research_transcript_cache t on t.id = a.transcript_cache_id and t.organization_id = a.organization_id and t.brand_id = a.brand_id
    left join research_analysis_runs r on r.id = a.analysis_id and r.organization_id = a.organization_id and r.brand_id = a.brand_id
    where a.organization_id = ${organizationId} and a.brand_id = ${brandId}
    order by a.captured_at desc limit 100
  `;
  return rows.map((row) => ({
    id: text(row.id), externalId: text(row.external_id), advertiser: text(row.advertiser), url: text(row.original_url),
    capturedAt: text(row.captured_at), publishedAt: text(row.published_at) || null, copy: text(row.copy), headline: text(row.headline),
    description: text(row.description), mediaType: text(row.media_type), mediaStatus: text(row.media_status),
    mediaStorageKey: text(row.media_storage_key), mediaBytes: number(row.media_bytes), durationMs: number(row.media_duration_ms),
    transcriptStatus: text(row.transcript_status), transcript: text(row.transcript).slice(0, 12000),
    segments: text(row.segments),
    analysisStatus: text(row.analysis_status), analysis: text(row.analysis),
    confidence: number(row.confidence), reviewRequired: row.review_required === true || row.review_required === "t" || row.review_required === "true",
    provider: text(row.provider), model: text(row.model), schemaVersion: text(row.schema_version), error: text(row.last_error),
    creativeId: text(row.creative_id),
    // The id /api/assets/<id> serves for the stored media. Null when the media is not stored.
    mediaAssetId: text(row.media_asset_id) || null,
  }));
}
