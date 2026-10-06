import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { aggregateResearchPatterns, type ResearchPattern } from "./patterns.ts";
import { RESEARCH_SCHEMA_VERSION, type ResearchAnalysis } from "./schema.ts";
import type { TranscriptionResult } from "./transcription.ts";
import type { MetaLibraryAd } from "../providers/meta-research.ts";

export async function persistMetaAd(sql: Sql, input: { organizationId: string; brandId: string; runId: string; ad: MetaLibraryAd }): Promise<string> {
  const id = randomUUID();
  const rows = await sql<{ id: string }>`
    insert into research_ads (
      id, organization_id, brand_id, collection_run_id, external_id, page_id, advertiser, original_url,
      captured_at, published_at, copy, headline, description, platforms, media_type
    ) values (
      ${id}, ${input.organizationId}, ${input.brandId}, ${input.runId}, ${input.ad.externalId}, ${input.ad.pageId},
      ${input.ad.advertiser}, ${input.ad.snapshotUrl}, ${input.ad.capturedAt}, ${input.ad.publishedAt},
      ${input.ad.copy}, ${input.ad.headline}, ${input.ad.description}, ${JSON.stringify(input.ad.platforms)}, ${input.ad.mediaType}
    ) on conflict (organization_id, brand_id, source, external_id) do update set
      collection_run_id = excluded.collection_run_id,
      original_url = excluded.original_url,
      captured_at = excluded.captured_at,
      updated_at = now()
    returning id
  `;
  const researchAdId = rows[0]?.id;
  if (!researchAdId) throw new Error("Meta ad record was not durably stored.");
  const sourceIdentifier = `meta_ad_library:${input.ad.externalId}`;
  const creativeRows = await sql<{ id: string }>`
    insert into creative_records (
      id, organization_id, brand_id, origin, source_url, source_identifier, title, raw_text,
      format, platform, status, created_by
    ) values (
      ${randomUUID()}, ${input.organizationId}, ${input.brandId}, 'competitor', ${input.ad.snapshotUrl},
      ${sourceIdentifier}, ${input.ad.advertiser}, ${[input.ad.copy, input.ad.headline, input.ad.description].filter(Boolean).join("\n")},
      'video', 'meta', 'observed', 'research.collect'
    ) on conflict (brand_id, source_identifier) where source_identifier <> '' do update set
      source_url = excluded.source_url, title = excluded.title, raw_text = excluded.raw_text, updated_at = now()
    returning id
  `;
  const creativeId = creativeRows[0]?.id;
  if (!creativeId) throw new Error("Meta ad creative record was not durably stored.");
  await sql`update research_ads set creative_id = ${creativeId} where id = ${researchAdId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}`;
  return researchAdId;
}

export async function persistResearchVideo(sql: Sql, input: {
  organizationId: string; brandId: string; researchAdId: string; bytes: Uint8Array; mimeType: string; durationMs: number | null;
}): Promise<{ storageKey: string; checksum: string }> {
  if (input.mimeType !== "video/mp4" || input.bytes.byteLength < 12 || String.fromCharCode(...input.bytes.slice(4, 8)) !== "ftyp") {
    throw new Error("The source media is not a verified MP4. It was not stored.");
  }
  if (!Number.isSafeInteger(input.bytes.byteLength) || input.bytes.byteLength > 24_000_000) throw new Error("The source video is larger than the 24 MB research storage limit.");
  const checksum = createHash("sha256").update(input.bytes).digest("hex");
  const storageKey = `research/${input.brandId}/${input.researchAdId}/${checksum}.mp4`;
  const adRows = await sql<{ creative_id: string; media_sha256: string }>`
    select creative_id, media_sha256 from research_ads where id = ${input.researchAdId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId} limit 1
  `;
  const creativeId = adRows[0]?.creative_id;
  if (!creativeId) throw new Error("Research ad is not owned by this tenant and brand.");
  await sql`
    insert into asset_blobs (storage_key, organization_id, brand_id, body, mime_type, checksum, byte_size, version, lifecycle)
    values (${storageKey}, ${input.organizationId}, ${input.brandId}, ${Buffer.from(input.bytes).toString("base64")}, 'video/mp4', ${checksum}, ${input.bytes.byteLength}, 1, 'stored')
    on conflict (storage_key) do nothing
  `;
  const priorAsset = await sql<{ id: string }>`select id from assets where organization_id = ${input.organizationId} and brand_id = ${input.brandId} and storage_key = ${storageKey} limit 1`;
  if (!priorAsset[0]) {
    await sql`
      insert into assets (
        id, organization_id, brand_id, creative_id, version, storage_key, content_hash, mime_type, source, status,
        lifecycle, checksum, byte_size, duration_ms, kind, media_status, provenance
      ) values (
        ${randomUUID()}, ${input.organizationId}, ${input.brandId}, ${creativeId}, 1, ${storageKey}, ${checksum},
        'video/mp4', 'meta_ad_library', 'stored', 'stored', ${checksum}, ${input.bytes.byteLength}, ${input.durationMs},
        'video', 'completed', 'meta_ad_library'
      )
    `;
  }
  await sql`
    update research_ads set media_status = 'stored', media_storage_key = ${storageKey}, media_mime_type = 'video/mp4',
      transcript_status = case when media_sha256 <> ${checksum} then 'pending' else transcript_status end,
      transcript_cache_id = case when media_sha256 <> ${checksum} then null else transcript_cache_id end,
      analysis_status = case when media_sha256 <> ${checksum} then 'pending' else analysis_status end,
      analysis_id = case when media_sha256 <> ${checksum} then null else analysis_id end,
      media_sha256 = ${checksum}, media_bytes = ${input.bytes.byteLength}, media_duration_ms = ${input.durationMs}, updated_at = now()
    where id = ${input.researchAdId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
  `;
  return { storageKey, checksum };
}

export async function persistTranscript(sql: Sql, input: {
  organizationId: string; brandId: string; researchAdId: string; transcript: TranscriptionResult;
}): Promise<{ id: string; reused: boolean }> {
  const result = input.transcript;
  if (result.status === "failed") throw new Error(result.error);
  if (result.status === "NOT_CONNECTED") throw new Error(result.error);
  const provider = result.provider;
  const model = result.model;
  const previous = await sql<{ id: string; transcript: string; segments: string; duration_ms: number | null; status: string }>`
    select id, transcript, segments, duration_ms, status from research_transcript_cache
    where organization_id = ${input.organizationId} and brand_id = ${input.brandId} and content_hash = ${result.contentHash} and provider = ${provider} and model = ${model}
    limit 1
  `;
  let transcriptId = previous[0]?.id ?? "";
  if (!transcriptId) {
    const id = randomUUID();
    const inserted = await sql<{ id: string }>`
      insert into research_transcript_cache (id, organization_id, brand_id, content_hash, provider, model, status, transcript, segments, duration_ms)
      values (${id}, ${input.organizationId}, ${input.brandId}, ${result.contentHash}, ${provider}, ${model}, ${result.status}, ${result.transcript}, ${JSON.stringify(result.segments)}, ${result.durationMs})
      on conflict (organization_id, brand_id, content_hash, provider, model) do nothing returning id
    `;
    transcriptId = inserted[0]?.id ?? "";
    if (!transcriptId) {
      const retry = await sql<{ id: string }>`select id from research_transcript_cache where organization_id = ${input.organizationId} and brand_id = ${input.brandId} and content_hash = ${result.contentHash} and provider = ${provider} and model = ${model} limit 1`;
      transcriptId = retry[0]?.id ?? "";
    }
  }
  if (!transcriptId) throw new Error("The research transcript cache was not stored.");
  await sql`
    update research_ads set transcript_status = ${result.status}, transcript_cache_id = ${transcriptId}, updated_at = now()
    where id = ${input.researchAdId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
  `;
  return { id: transcriptId, reused: Boolean(previous[0]) };
}

export async function saveResearchAnalysis(sql: Sql, input: {
  organizationId: string; brandId: string; researchAdId: string; cacheKey: string;
  provider: string; model: string; promptVersion: string; latencyMs: number; tokens: number | null; analysis: ResearchAnalysis;
}): Promise<string> {
  const fields = ["topic", "openingMove", "hookMechanism", "hook", "structure", "evidenceOffered", "emotionalAppeal", "adviceSpecificity", "cta"] as const;
  const confidence = fields.reduce((sum, key) => sum + input.analysis[key].confidence, 0) / fields.length;
  const status = input.analysis.reviewRequired ? "review" : "analyzed";
  const inserted = await sql<{ id: string }>`
    insert into research_analysis_runs (id, organization_id, brand_id, research_ad_id, cache_key, schema_version, provider, model, prompt_version, latency_ms, tokens, status, confidence, review_required, result)
    values (${randomUUID()}, ${input.organizationId}, ${input.brandId}, ${input.researchAdId}, ${input.cacheKey}, ${input.analysis.schemaVersion}, ${input.provider}, ${input.model}, ${input.promptVersion}, ${input.latencyMs}, ${input.tokens}, ${status}, ${confidence}, ${input.analysis.reviewRequired}, ${JSON.stringify(input.analysis)})
    on conflict (organization_id, brand_id, research_ad_id, cache_key) do nothing returning id
  `;
  let analysisId = inserted[0]?.id ?? "";
  if (!analysisId) {
    const previous = await sql<{ id: string }>`select id from research_analysis_runs where organization_id = ${input.organizationId} and brand_id = ${input.brandId} and research_ad_id = ${input.researchAdId} and cache_key = ${input.cacheKey} limit 1`;
    analysisId = previous[0]?.id ?? "";
  }
  if (!analysisId) throw new Error("The JEV Research analysis was not stored.");
  for (const key of fields) {
    const answer = input.analysis[key];
    await sql`
      insert into research_analysis_fields (analysis_id, organization_id, brand_id, field, value, confidence, probability, evidence_ids)
      values (${analysisId}, ${input.organizationId}, ${input.brandId}, ${key}, ${answer.value}, ${answer.confidence}, ${answer.probability ?? null}, ${JSON.stringify(answer.evidence)})
      on conflict (analysis_id, field) do update set value = excluded.value, confidence = excluded.confidence, probability = excluded.probability, evidence_ids = excluded.evidence_ids
    `;
  }
  for (const segment of input.analysis.segments) {
    await sql`
      insert into research_segments (analysis_id, organization_id, brand_id, segment_id, transcript, start_ms, end_ms, role, confidence)
      values (${analysisId}, ${input.organizationId}, ${input.brandId}, ${segment.id}, ${segment.text}, ${segment.startMs}, ${segment.endMs}, ${segment.role}, ${segment.confidence})
      on conflict (analysis_id, segment_id) do update set role = excluded.role, confidence = excluded.confidence
    `;
  }
  await sql`
    update research_ads set analysis_status = ${status}, analysis_id = ${analysisId}, last_error = '', updated_at = now()
    where id = ${input.researchAdId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
  `;
  return analysisId;
}

export async function loadReusableResearchAnalysis(sql: Sql, input: {
  organizationId: string; brandId: string; researchAdId: string; videoHash: string;
}): Promise<{ analysis: ResearchAnalysis; cacheKey: string; provider: string; model: string; promptVersion: string; latencyMs: number; tokens: number | null } | null> {
  const rows = await sql<{ result: string; cache_key: string; provider: string; model: string; prompt_version: string; latency_ms: number; tokens: number | null }>`
    select r.result, r.cache_key, r.provider, r.model, r.prompt_version, r.latency_ms, r.tokens
    from research_ads a
      join research_transcript_cache t on t.id = a.transcript_cache_id and t.organization_id = a.organization_id and t.brand_id = a.brand_id
      join research_analysis_runs r on r.id = a.analysis_id and r.organization_id = a.organization_id and r.brand_id = a.brand_id
    where a.id = ${input.researchAdId} and a.organization_id = ${input.organizationId} and a.brand_id = ${input.brandId}
      and t.content_hash = ${input.videoHash} and r.schema_version = ${RESEARCH_SCHEMA_VERSION}
      and r.prompt_version = ${RESEARCH_SCHEMA_VERSION} and r.status in ('analyzed', 'review')
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  try {
    return {
      analysis: JSON.parse(row.result) as ResearchAnalysis,
      cacheKey: row.cache_key,
      provider: row.provider,
      model: row.model,
      promptVersion: row.prompt_version,
      latencyMs: Number(row.latency_ms) || 0,
      tokens: row.tokens == null ? null : Number(row.tokens),
    };
  } catch { return null; }
}

export async function upsertResearchCreative(sql: Sql, input: { organizationId: string; brandId: string; researchAdId: string; analysis: ResearchAnalysis }): Promise<string> {
  const ads = await sql<{ creative_id: string; advertiser: string; original_url: string; platforms: string }>`
    select creative_id, advertiser, original_url, platforms from research_ads
    where id = ${input.researchAdId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId} limit 1
  `;
  const ad = ads[0];
  if (!ad?.creative_id) throw new Error("Research ad is not owned by this tenant and brand.");
  const analysis = input.analysis;
  const rawText = analysis.segments.map((segment) => segment.text).join(" ");
  await sql`
    update creative_records set title = ${ad.advertiser}, source_url = ${ad.original_url}, raw_text = ${rawText},
      angle = ${analysis.topic.value}, hook = ${analysis.hook.value}, hook_type = ${analysis.hookMechanism.value},
      format = 'video', platform = 'meta', proof_type = ${analysis.evidenceOffered.value}, cta = ${analysis.cta.value},
      emotion = ${analysis.emotionalAppeal.value}, narrative = ${analysis.structure.value}, updated_at = now()
    where id = ${ad.creative_id} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
  `;
  await sql`
    update research_ads set creative_id = ${ad.creative_id}, updated_at = now()
    where id = ${input.researchAdId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
  `;
  return ad.creative_id;
}

export async function rebuildResearchPatterns(sql: Sql, organizationId: string, brandId: string): Promise<ResearchPattern[]> {
  const rows = await sql<{ research_ad_id: string; creative_id: string; analysis_id: string; result: string; captured_at: string }>`
    select a.id as research_ad_id, a.creative_id, r.id as analysis_id, r.result, a.captured_at
    from research_ads a join research_analysis_runs r on r.id = a.analysis_id
    where a.organization_id = ${organizationId} and a.brand_id = ${brandId} and a.analysis_status in ('analyzed', 'review')
      and r.organization_id = ${organizationId} and r.brand_id = ${brandId}
  `;
  const analyses = rows.flatMap((row) => {
    try { return row.creative_id ? [{ researchAdId: row.research_ad_id, creativeId: row.creative_id, analysisId: row.analysis_id, analysis: JSON.parse(row.result) as ResearchAnalysis }] : []; }
    catch { return []; }
  });
  const patterns = aggregateResearchPatterns(analyses.map((row) => ({ adId: row.creativeId, analysisId: row.analysisId, analysis: row.analysis })));
  for (const pattern of patterns) {
    await sql`
      insert into research_patterns (id, organization_id, brand_id, scope, dimension, value, state, sample_count, corpus_size, prevalence, confidence, analysis_ids, example_creative_ids, summary)
      values (${randomUUID()}, ${organizationId}, ${brandId}, 'brand', ${pattern.dimension}, ${pattern.value}, ${pattern.state}, ${pattern.sampleCount}, ${pattern.corpusSize}, ${pattern.prevalence}, ${pattern.confidence}, ${JSON.stringify(pattern.exampleAnalysisIds ?? [])}, ${JSON.stringify(pattern.exampleAdIds)}, ${pattern.summary})
      on conflict (organization_id, brand_id, dimension, value) do update set state = excluded.state, sample_count = excluded.sample_count, corpus_size = excluded.corpus_size, prevalence = excluded.prevalence, confidence = excluded.confidence, analysis_ids = excluded.analysis_ids, example_creative_ids = excluded.example_creative_ids, summary = excluded.summary, created_at = now()
    `;
  }
  return patterns;
}

/** Rebuild organization summaries for explicitly opted-in brands; examples never cross brand boundaries. */
export async function rebuildOrganizationResearchPatterns(sql: Sql, organizationId: string): Promise<ResearchPattern[]> {
  const rows = await sql<{ research_ad_id: string; creative_id: string; analysis_id: string; result: string }>`
    select distinct on (a.source, a.external_id) a.id as research_ad_id, a.creative_id, r.id as analysis_id, r.result
    from research_ads a join research_analysis_runs r on r.id = a.analysis_id
    where a.organization_id = ${organizationId} and a.analysis_status in ('analyzed', 'review')
      and r.organization_id = ${organizationId} and r.brand_id = a.brand_id
    order by a.source, a.external_id, a.captured_at desc
  `;
  const analyses = rows.flatMap((row) => {
    try { return row.creative_id ? [{ creativeId: row.creative_id, analysisId: row.analysis_id, analysis: JSON.parse(row.result) as ResearchAnalysis }] : []; }
    catch { return []; }
  });
  const patterns = aggregateResearchPatterns(analyses.map((row) => ({ adId: row.creativeId, analysisId: row.analysisId, analysis: row.analysis })));
  for (const pattern of patterns) {
    await sql`
      insert into research_patterns (id, organization_id, brand_id, scope, dimension, value, state, sample_count, corpus_size, prevalence, confidence, analysis_ids, example_creative_ids, summary)
      values (${randomUUID()}, ${organizationId}, null, 'organization', ${pattern.dimension}, ${pattern.value}, ${pattern.state}, ${pattern.sampleCount}, ${pattern.corpusSize}, ${pattern.prevalence}, ${pattern.confidence}, '[]', '[]', ${pattern.summary})
      on conflict (organization_id, dimension, value) where scope = 'organization' do update set state = excluded.state, sample_count = excluded.sample_count, corpus_size = excluded.corpus_size, prevalence = excluded.prevalence, confidence = excluded.confidence, analysis_ids = '[]', example_creative_ids = '[]', summary = excluded.summary, created_at = now()
    `;
  }
  return patterns.map((pattern) => ({ ...pattern, scope: "organization", exampleAdIds: [], exampleAnalysisIds: [] }));
}

export function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
