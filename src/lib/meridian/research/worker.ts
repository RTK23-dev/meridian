import { randomUUID } from "node:crypto";
import { analyzeResearchTranscript } from "./analyzer.ts";
import { metaSnapshotVideoUrl, isMp4 } from "./media.ts";
import { loadReusableResearchAnalysis, persistMetaAd, persistResearchVideo, persistTranscript, rebuildOrganizationResearchPatterns, rebuildResearchPatterns, saveResearchAnalysis, sha256, upsertResearchCreative } from "./store.ts";
import { transcribeVideo, type TranscriptionResult } from "./transcription.ts";
import { collectMetaAdLibrary } from "../providers/meta-research.ts";
import { liveTransport } from "../providers/http.ts";
import { activeChatProvider, providerStatus } from "../providers/chat.server.ts";
import { fetchPublicHtml, fetchPublicMedia } from "../sources/fetch-page.server.ts";
import type { Sql } from "../learning/store.ts";
import type { ExecutableJob } from "../jobs/execute.ts";
import { rerankBrand } from "../opportunity/rerank.ts";
import { RESEARCH_SCHEMA_VERSION, type ResearchSegment } from "./schema.ts";
import { applyCheapGate, gateMaxAdsPerRun } from "./gate.ts";
import { snapshotMediaAllowed } from "../factory/sources.ts";
import { emptyYield, formatYield } from "../factory/yield.ts";
import { jevDecisionService } from "../jev/service.ts";
import type { EvidenceBundle } from "../evidence/types.ts";

const MAX_VIDEO_BYTES = 24_000_000;
const MAX_RUN_MEDIA_BYTES = 100_000_000;

function parseSegments(value: string): ResearchSegment[] {
  return JSON.parse(value) as ResearchSegment[];
}

async function retryCollection(sql: Sql, job: ExecutableJob, runId: string, message: string): Promise<never> {
  const finalAttempt = job.attempts + 1 >= job.max_attempts;
  await sql`update research_collection_runs set status = ${finalAttempt ? "failed" : "retry"}, error = ${message.slice(0, 500)}, updated_at = now() where id = ${runId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id}`;
  throw new Error(message);
}

async function recordAdFailure(sql: Sql, input: { organizationId: string; brandId: string; adId: string; stage: "media" | "transcript" | "analysis"; status: "failed" | "unavailable" | "NOT_CONNECTED"; message: string }): Promise<void> {
  if (input.stage === "media") {
    await sql`update research_ads set media_status = ${input.status}, last_error = ${input.message.slice(0, 500)}, updated_at = now() where id = ${input.adId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}`;
  } else if (input.stage === "transcript") {
    await sql`update research_ads set transcript_status = ${input.status}, last_error = ${input.message.slice(0, 500)}, updated_at = now() where id = ${input.adId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}`;
  } else {
    await sql`update research_ads set analysis_status = ${input.status}, last_error = ${input.message.slice(0, 500)}, updated_at = now() where id = ${input.adId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}`;
  }
}

async function transcriptForVideo(sql: Sql, videoBytes: Uint8Array, input: { organizationId: string; brandId: string; adId: string }): Promise<TranscriptionResult> {
  const hash = sha256(videoBytes);
  const model = process.env.WHISPERX_MODEL?.trim() || "small";
  const cached = await sql<{ id: string; status: string; transcript: string; segments: string; duration_ms: number | null }>`
    select id, status, transcript, segments, duration_ms from research_transcript_cache
    where organization_id = ${input.organizationId} and brand_id = ${input.brandId} and content_hash = ${hash} and provider = 'local:whisperx' and model = ${model}
    limit 1
  `;
  if (cached[0]) {
    const row = cached[0];
    if (row.status === "no_speech") return { status: "no_speech", transcript: "", segments: [], provider: "local:whisperx", model, contentHash: hash, durationMs: row.duration_ms };
    return { status: "transcribed", transcript: row.transcript, segments: parseSegments(row.segments), provider: "local:whisperx", model, contentHash: hash, durationMs: row.duration_ms };
  }
  return transcribeVideo(videoBytes);
}

export async function executeResearchCollection(sql: Sql, job: ExecutableJob, payload: Record<string, unknown>): Promise<string> {
  const runId = typeof payload.runId === "string" ? payload.runId : "";
  const searchTerms = typeof payload.searchTerms === "string" ? payload.searchTerms : "";
  const country = typeof payload.country === "string" ? payload.country : "US";
  const maxAds = Number(payload.limit) || 50;
  const runs = await sql<{ id: string }>`
    select id from research_collection_runs where id = ${runId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id} limit 1
  `;
  if (!runs[0] || !job.brand_id) throw new Error("Research collection run is not owned by this organization and brand.");
  await sql`update research_collection_runs set status = 'collecting', error = '', updated_at = now() where id = ${runId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id}`;
  const collected = await collectMetaAdLibrary({ token: process.env.META_AD_LIBRARY_TOKEN, searchTerms, country, limit: maxAds, transport: liveTransport() });
  if (collected.status === "NOT_CONNECTED") {
    await sql`update research_collection_runs set status = 'NOT_CONNECTED', error = ${collected.error}, updated_at = now() where id = ${runId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id}`;
    await sql`
      insert into source_connections (id, organization_id, brand_id, source, status, last_error)
      values (${`${job.organization_id}:${job.brand_id}:ad_library`}, ${job.organization_id}, ${job.brand_id}, 'ad_library', 'NOT_CONNECTED', ${collected.error})
      on conflict (id) do update set status = excluded.status, last_error = excluded.last_error, updated_at = now()
    `;
    return "NOT_CONNECTED";
  }
  if (collected.status === "FAILED") {
    return retryCollection(sql, job, runId, collected.error);
  }
  await sql`
    insert into source_connections (id, organization_id, brand_id, source, status, last_error)
    values (${`${job.organization_id}:${job.brand_id}:ad_library`}, ${job.organization_id}, ${job.brand_id}, 'ad_library', 'CONNECTED', '')
    on conflict (id) do update set status = excluded.status, last_error = '', updated_at = now()
  `;
  let analyzedCount = 0;
  let videosDownloaded = 0;
  let transcriptsProduced = 0;
  let snapshotWithoutVideo = 0;
  let mediaFailed = 0;
  const allowSnapshotMedia = snapshotMediaAllowed();
  const yieldRow = emptyYield(searchTerms);
  yieldRow.snapshotMediaEnabled = allowSnapshotMedia;
  // Persist every ad first, so the cheap gate ranks the whole run before any media is downloaded (research/gate.ts).
  const persisted: { ad: (typeof collected.ads)[number]; adId: string }[] = [];
  for (const ad of collected.ads) {
    persisted.push({ ad, adId: await persistMetaAd(sql, { organizationId: job.organization_id, brandId: job.brand_id, runId, ad }) });
  }
  const gateSkipped = new Set<string>();
  if (allowSnapshotMedia) {
    const gate = await applyCheapGate(sql, {
      organizationId: job.organization_id,
      brandId: job.brand_id,
      maxAdsPerRun: gateMaxAdsPerRun(),
      candidates: persisted.filter(({ ad }) => ad.mediaType === "VIDEO").map(({ ad, adId }) => ({
        adId, externalId: ad.externalId, copy: ad.copy, headline: ad.headline, description: ad.description, capturedAt: ad.capturedAt, publishedAt: ad.publishedAt,
      })),
    });
    for (const item of gate.skipped) gateSkipped.add(item.adId);
  }
  for (const { ad, adId } of persisted) {
    if (gateSkipped.has(adId)) continue;
    if (ad.mediaType !== "VIDEO") {
      await recordAdFailure(sql, { organizationId: job.organization_id, brandId: job.brand_id, adId, stage: "media", status: "unavailable", message: "This archived record is not a video ad." });
      snapshotWithoutVideo += 1;
      continue;
    }
    if (!allowSnapshotMedia) {
      await recordAdFailure(sql, { organizationId: job.organization_id, brandId: job.brand_id, adId, stage: "media", status: "unavailable", message: "Snapshot video download is off. Metadata was stored. Set RESEARCH_SNAPSHOT_MEDIA=1 only after a rights review." });
      snapshotWithoutVideo += 1;
      continue;
    }
    let bytes: Uint8Array;
    try {
      const storedRows = await sql<{ stored_bytes: number | string }>`
        select coalesce(sum(media_bytes), 0) as stored_bytes from research_ads
        where organization_id = ${job.organization_id} and brand_id = ${job.brand_id}
          and collection_run_id = ${runId} and media_status = 'stored'
      `;
      const usedBytes = Number(storedRows[0]?.stored_bytes ?? 0);
      const remainingBytes = MAX_RUN_MEDIA_BYTES - usedBytes;
      if (remainingBytes <= 0) {
        await recordAdFailure(sql, { organizationId: job.organization_id, brandId: job.brand_id, adId, stage: "media", status: "unavailable", message: "The 100 MB per-run source-media storage limit has been reached. This ad was not downloaded." });
        continue;
      }
      const snapshot = await fetchPublicHtml(ad.snapshotRequestUrl);
      const mediaUrl = metaSnapshotVideoUrl(snapshot.html);
      if (!mediaUrl) {
        await recordAdFailure(sql, { organizationId: job.organization_id, brandId: job.brand_id, adId, stage: "media", status: "unavailable", message: "Meta's snapshot did not expose a downloadable video. No transcript or analysis was created." });
        continue;
      }
      await sql`update research_ads set media_url = ${mediaUrl}, updated_at = now() where id = ${adId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id}`;
      const media = await fetchPublicMedia(mediaUrl, 0, Math.min(MAX_VIDEO_BYTES, remainingBytes));
      if (media.mimeType !== "video/mp4" || !isMp4(media.bytes)) throw new Error("The source did not return a verified MP4.");
      bytes = media.bytes;
      await persistResearchVideo(sql, { organizationId: job.organization_id, brandId: job.brand_id, researchAdId: adId, bytes, mimeType: media.mimeType, durationMs: null });
      videosDownloaded += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Media ingestion failed.";
      if (/larger than the .*research limit/i.test(message)) {
        await recordAdFailure(sql, { organizationId: job.organization_id, brandId: job.brand_id, adId, stage: "media", status: "unavailable", message });
        continue;
      }
      await recordAdFailure(sql, { organizationId: job.organization_id, brandId: job.brand_id, adId, stage: "media", status: "failed", message });
      mediaFailed += 1;
      return retryCollection(sql, job, runId, message);
    }
    const transcript = await transcriptForVideo(sql, bytes, { organizationId: job.organization_id, brandId: job.brand_id, adId });
    if (transcript.status === "NOT_CONNECTED" || transcript.status === "failed") {
      await recordAdFailure(sql, { organizationId: job.organization_id, brandId: job.brand_id, adId, stage: "transcript", status: transcript.status, message: transcript.error });
      if (transcript.status === "failed") return retryCollection(sql, job, runId, transcript.error);
      continue;
    }
    const storedTranscript = await persistTranscript(sql, { organizationId: job.organization_id, brandId: job.brand_id, researchAdId: adId, transcript });
    transcriptsProduced += 1;
    if (transcript.status === "no_speech") continue;
    await sql`update research_ads set media_duration_ms = ${transcript.durationMs} where id = ${adId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id}`;
    const reusable = await loadReusableResearchAnalysis(sql, { organizationId: job.organization_id, brandId: job.brand_id, researchAdId: adId, videoHash: sha256(bytes) });
    const provider = reusable ? null : activeChatProvider();
    const model = reusable ? null : providerStatus();
    if (!reusable && !provider) {
      await recordAdFailure(sql, { organizationId: job.organization_id, brandId: job.brand_id, adId, stage: "analysis", status: "NOT_CONNECTED", message: "No JEV Research chat model is configured. The transcript was stored; analysis was not created." });
      continue;
    }
    const startedAt = Date.now();
    let analysis: Awaited<ReturnType<typeof analyzeResearchTranscript>>;
    if (reusable) {
      analysis = { status: "analyzed", analysis: reusable.analysis, key: reusable.cacheKey, provider: reusable.provider, model: reusable.model, latencyMs: reusable.latencyMs, tokens: reusable.tokens };
    } else try {
      analysis = await analyzeResearchTranscript({
        sourceId: adId,
        transcript: transcript.transcript,
        segments: transcript.segments,
        provider: provider!.id,
        model: model!.model,
        complete: (request) => provider!.complete(request),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "JEV Research analysis failed.";
      await sql`
        insert into model_runs (id, organization_id, brand_id, correlation_id, operation, provider, model, prompt_id, prompt_version, input_ref, latency_ms, status, error)
        values (${randomUUID()}, ${job.organization_id}, ${job.brand_id}, ${runId}, 'jev.research.analysis', ${provider!.id}, ${model!.model}, 'jev.research.analysis', ${RESEARCH_SCHEMA_VERSION}, ${adId}, ${Date.now() - startedAt}, 'failed', ${message.slice(0, 500)})
      `;
      await recordAdFailure(sql, { organizationId: job.organization_id, brandId: job.brand_id, adId, stage: "analysis", status: "failed", message });
      return retryCollection(sql, job, runId, message);
    }
    if (analysis.status !== "analyzed") {
      await recordAdFailure(sql, { organizationId: job.organization_id, brandId: job.brand_id, adId, stage: "analysis", status: analysis.status, message: analysis.error });
      if (analysis.status === "failed") {
        await sql`
          insert into model_runs (id, organization_id, brand_id, correlation_id, operation, provider, model, prompt_id, prompt_version, input_ref, latency_ms, status, error)
          values (${randomUUID()}, ${job.organization_id}, ${job.brand_id}, ${runId}, 'jev.research.analysis', ${provider!.id}, ${model!.model}, 'jev.research.analysis', ${RESEARCH_SCHEMA_VERSION}, ${adId}, ${Date.now() - startedAt}, 'failed', ${analysis.error.slice(0, 500)})
        `;
        return retryCollection(sql, job, runId, analysis.error);
      }
      continue;
    }
    if (!reusable) await sql`
      insert into model_runs (id, organization_id, brand_id, correlation_id, operation, provider, model, prompt_id, prompt_version, input_ref, output, latency_ms, tokens, status, error)
      values (${randomUUID()}, ${job.organization_id}, ${job.brand_id}, ${runId}, 'jev.research.analysis', ${analysis.provider}, ${analysis.model}, 'jev.research.analysis', ${analysis.analysis.schemaVersion}, ${adId}, ${JSON.stringify(analysis.analysis)}, ${analysis.latencyMs}, ${analysis.tokens}, 'succeeded', '')
    `;
    await saveResearchAnalysis(sql, { organizationId: job.organization_id, brandId: job.brand_id, researchAdId: adId, cacheKey: analysis.key, provider: analysis.provider, model: analysis.model, promptVersion: analysis.analysis.schemaVersion, latencyMs: analysis.latencyMs, tokens: analysis.tokens, analysis: analysis.analysis });
    const creativeId = await upsertResearchCreative(sql, { organizationId: job.organization_id, brandId: job.brand_id, researchAdId: adId, analysis: analysis.analysis });
    const { embedWithProvider } = await import("../embeddings/select.ts");
    try {
      const text = `${analysis.analysis.hook.value}\n${transcript.transcript}`.slice(0, 800);
      const [vector] = await embedWithProvider("local:semantic", [text]);
      if (vector) {
        await sql`
          insert into creative_embeddings (id, organization_id, brand_id, creative_id, provider, model, dimensions, vector)
          values (${`${creativeId}:${vector.provider}`}, ${job.organization_id}, ${job.brand_id}, ${creativeId}, ${vector.provider}, ${vector.model}, ${vector.dimensions}, ${JSON.stringify(vector.values)})
          on conflict (creative_id, provider, model) do update set vector = excluded.vector, dimensions = excluded.dimensions
        `;
      }
    } catch { /* A failed MiniLM call stores no substitute vector and does not invalidate source analysis. */ }

    // Evaluate Evidence with model-backed Native JEV decision layer
    try {
      const bundle: EvidenceBundle = {
        id: adId,
        organizationId: job.organization_id,
        brandId: job.brand_id,
        source: {
          platform: "meta",
          sourceAdapter: "meta_ad_library",
          canonicalUrl: ad.snapshotUrl,
          externalId: ad.externalId,
          capturedAt: ad.capturedAt,
        },
        content: {
          type: "video",
          title: ad.headline || undefined,
          caption: ad.copy || undefined,
          description: ad.description || undefined,
        },
        provenance: {
          adapterId: "meta_ad_library",
          sourceUrl: ad.snapshotRequestUrl || ad.snapshotUrl,
          externalId: ad.externalId,
          capturedAt: ad.capturedAt,
        },
        availableEvidence: [
          "transcript",
          "metadata",
          "video_metadata",
          "topic",
          "hook",
          "structure",
          "claims",
        ],
        transcript: transcript.segments.map((s) => ({
          id: s.id,
          text: s.text,
          startMs: s.startMs ?? 0,
          endMs: s.endMs ?? 0,
          confidence: 0.9,
        })),
        metrics: {
          durationMs: transcript.durationMs ?? 0,
        },
        evidenceRefs: [
          { field: "transcript", artifactId: adId },
          { field: "metadata", artifactId: adId },
        ],
        createdAt: ad.capturedAt || new Date().toISOString(),
      };

      await jevDecisionService.evaluateEvidence({
        organizationId: job.organization_id,
        brandId: job.brand_id,
        bundle,
        sql,
      });
    } catch {
      // JEV evaluation failure or unconfigured state is non-fatal for collection run
    }

    analyzedCount += 1;
    await sql`update research_collection_runs set analyzed_count = ${analyzedCount}, updated_at = now() where id = ${runId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id}`;
    void storedTranscript;
  }
  yieldRow.adsFound = collected.ads.length;
  yieldRow.videosDownloaded = videosDownloaded;
  yieldRow.transcriptsProduced = transcriptsProduced;
  yieldRow.analysesCompleted = analyzedCount;
  yieldRow.snapshotWithoutVideo = snapshotWithoutVideo;
  yieldRow.mediaFailed = mediaFailed;
  const patterns = await rebuildResearchPatterns(sql, job.organization_id, job.brand_id);
  await rebuildOrganizationResearchPatterns(sql, job.organization_id);
  await rerankBrand(sql, job.organization_id, job.brand_id);
  await sql`update research_collection_runs set status = 'succeeded', collected_count = ${collected.ads.length}, analyzed_count = ${analyzedCount}, videos_downloaded = ${videosDownloaded}, transcripts_produced = ${transcriptsProduced}, snapshot_without_video = ${snapshotWithoutVideo}, yield_json = ${JSON.stringify(yieldRow)}, error = ${patterns.length ? "" : "No video analyses were available to aggregate."}, updated_at = now() where id = ${runId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id}`;
  return `ads:${collected.ads.length};analyzed:${analyzedCount};patterns:${patterns.length};opportunities:refreshed;${formatYield(yieldRow)}`;
}

export function newResearchRunId(): string { return randomUUID(); }
