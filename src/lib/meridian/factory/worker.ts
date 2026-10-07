import type { Sql } from "../learning/store.ts";
import type { ExecutableJob } from "../jobs/execute.ts";
import { CREATIVE_DNA_VERSION, dnaFromTranscript, type AdFormat, type CreativeDna } from "./creative-dna.ts";
import { decodeVideoDna } from "./decode.ts";
import type { ResearchSegment } from "../research/schema.ts";
import { combineGates, originalityGate, claimsGate, policyGate, rightsGate, brandGate } from "./gates.ts";
import { adsMustPause } from "./kill-switch.ts";
import { factoryStageAllowed, isFactoryStage } from "./pipeline.ts";
import { snapshotMediaAllowed } from "./sources.ts";
import { templateFromDna, variantMatrix } from "./template.ts";
import { buildAdTimeline } from "./timeline.ts";
import { winnerScore } from "./winner-score.ts";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export async function executeFactoryJob(sql: Sql, job: ExecutableJob, payload: Record<string, unknown>): Promise<string> {
  if (!isFactoryStage(job.job_type)) throw new Error(`No factory handler for ${job.job_type}.`);
  if (!job.brand_id) throw new Error("Factory jobs need a brand.");
  const runId = text(payload.runId);
  if (!runId) throw new Error("Factory jobs need a run id.");
  const owned = await sql<{ id: string; status: string; niche: string; level: number }>`
    select id, status, niche, level from factory_runs
    where id = ${runId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id}
    limit 1
  `;
  if (!owned[0]) throw new Error("Factory run is not owned by this organization and brand.");
  if (!factoryStageAllowed(owned[0].level, job.job_type)) return `skipped:above-level-${owned[0].level}`;
  const paused = await killSwitchPaused(sql, job.organization_id, job.brand_id);
  if (paused && (job.job_type === "factory.launch" || job.job_type === "factory.test")) {
    await sql`update factory_runs set status = 'paused', error = 'Kill switch is engaged. Live ads were not started.', updated_at = now() where id = ${runId} and organization_id = ${job.organization_id}`;
    return "kill-switch";
  }
  await sql`
    update factory_runs
    set status = case when status in ('queued', 'failed') then 'running' else status end,
        current_stage = ${job.job_type},
        error = '',
        updated_at = now()
    where id = ${runId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id}
  `;

  if (job.job_type === "factory.discover") {
    const token = process.env.META_AD_LIBRARY_TOKEN?.trim();
    return token ? "sources:meta_ad_library" : "NOT_CONNECTED:meta_ad_library";
  }
  if (job.job_type === "factory.ingest") {
    const allowed = snapshotMediaAllowed();
    return allowed ? "ingest:snapshot-media-opt-in" : "ingest:metadata-only";
  }
  if (job.job_type === "factory.decode") {
    const decoded = await decodeStoredAds(sql, job.organization_id, job.brand_id);
    await recordCost(sql, job, runId, "factory.decode", decoded * 2, decoded);
    return `decoded:${decoded}`;
  }
  if (job.job_type === "factory.grade") {
    const graded = await gradeStoredAds(sql, job.organization_id, job.brand_id);
    await recordCost(sql, job, runId, "factory.grade", graded, graded);
    return `graded:${graded}`;
  }
  if (job.job_type === "factory.trend") {
    const rows = await sql<{ n: number }>`
      select count(*)::int as n from research_ads
      where organization_id = ${job.organization_id} and brand_id = ${job.brand_id}
    `;
    return `clustered:${rows[0]?.n ?? 0}`;
  }
  if (job.job_type === "factory.pick") {
    const rows = await sql<{ n: number }>`
      select count(*)::int as n from ad_timelines
      where organization_id = ${job.organization_id} and brand_id = ${job.brand_id} and winner_score is not null
    `;
    return `picked:${rows[0]?.n ?? 0}`;
  }
  if (job.job_type === "factory.template") {
    const made = await persistTemplates(sql, job.organization_id, job.brand_id, runId);
    await recordCost(sql, job, runId, "factory.template", made * 3, made);
    if (owned[0].level === 0) {
      await sql`update factory_runs set status = 'succeeded', error = '', updated_at = now() where id = ${runId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id}`;
    }
    return `templates:${made}`;
  }
  if (job.job_type === "factory.produce") {
    const made = await persistVariants(sql, job.organization_id, job.brand_id, runId);
    await recordCost(sql, job, runId, "factory.produce", made * 12, made);
    return `variants:${made}`;
  }
  if (job.job_type === "factory.gate") {
    const gated = await gateVariants(sql, job.organization_id, job.brand_id);
    return `gated:${gated}`;
  }
  if (job.job_type === "factory.review") {
    const rows = await sql<{ n: number }>`
      select count(*)::int as n from factory_variants
      where organization_id = ${job.organization_id} and brand_id = ${job.brand_id} and gate_result = 'review'
    `;
    await sql`update factory_runs set status = 'succeeded', error = '', updated_at = now() where id = ${runId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id}`;
    return `review:${rows[0]?.n ?? 0}`;
  }
  if (job.job_type === "factory.launch") {
    const caps = await sql<{ daily_cents: number; total_cents: number }>`
      select daily_cents, total_cents from factory_spend_caps
      where organization_id = ${job.organization_id} and brand_id = ${job.brand_id}
      limit 1
    `;
    if (!caps[0] || (caps[0].daily_cents <= 0 && caps[0].total_cents <= 0)) {
      return "launch:blocked-no-cap";
    }
    return "launch:paused-until-owner";
  }
  if (job.job_type === "factory.test") {
    return "test:awaiting-live-results";
  }
  if (job.job_type === "factory.learn") {
    await sql`update factory_runs set status = 'succeeded', error = '', updated_at = now() where id = ${runId} and organization_id = ${job.organization_id} and brand_id = ${job.brand_id}`;
    return "learned";
  }
  return `queued:${job.job_type}`;
}

async function decodeStoredAds(sql: Sql, organizationId: string, brandId: string): Promise<number> {
  const ads = await sql<{
    id: string;
    copy: string;
    media_duration_ms: number | null;
    media_storage_key: string;
    transcript: string | null;
    segments: string | null;
  }>`
    select a.id, a.copy, a.media_duration_ms, a.media_storage_key, t.transcript, t.segments
    from research_ads a
    left join research_transcript_cache t on t.id = a.transcript_cache_id
    where a.organization_id = ${organizationId} and a.brand_id = ${brandId}
    order by a.captured_at desc
    limit 80
  `;
  let count = 0;
  for (const ad of ads) {
    let dna: CreativeDna;
    let videoBytes: Uint8Array | null = null;
    if (ad.media_storage_key) {
      const blob = await sql<{ body: string }>`
        select body from asset_blobs
        where storage_key = ${ad.media_storage_key} and organization_id = ${organizationId} and brand_id = ${brandId}
        limit 1
      `;
      if (blob[0]?.body) {
        videoBytes = new Uint8Array(Buffer.from(blob[0].body, "base64"));
      }
    }

    if (videoBytes && videoBytes.byteLength > 0) {
      let segments: ResearchSegment[] = [];
      try {
        if (ad.segments) segments = JSON.parse(ad.segments) as ResearchSegment[];
      } catch {
        segments = [];
      }
      dna = await decodeVideoDna({
        adId: ad.id,
        videoBytes,
        durationMs: ad.media_duration_ms,
        transcript: ad.transcript,
        segments,
      });
    } else {
      const source = (ad.transcript || ad.copy || "").trim();
      dna = dnaFromTranscript({
        adId: ad.id,
        durationMs: ad.media_duration_ms ?? 0,
        transcript: source,
        format: guessFormat(source),
        schema: CREATIVE_DNA_VERSION,
      });
    }

    const id = `dna:${brandId}:${ad.id}`;
    const embSql = dna.embedding && dna.embedding.length > 0 ? `[${dna.embedding.join(",")}]` : null;
    await sql`
      insert into creative_dna (id, organization_id, brand_id, research_ad_id, schema_version, record, embedding)
      values (${id}, ${organizationId}, ${brandId}, ${ad.id}, ${CREATIVE_DNA_VERSION}, ${JSON.stringify(dna)}, ${embSql})
      on conflict (organization_id, brand_id, research_ad_id, schema_version) do update
        set record = excluded.record, embedding = excluded.embedding
    `;
    count += 1;
  }
  return count;
}

async function gradeStoredAds(sql: Sql, organizationId: string, brandId: string): Promise<number> {
  const ads = await sql<{
    id: string;
    captured_at: unknown;
    published_at: unknown;
    platforms: string;
    analysis_status: string;
  }>`
    select id, captured_at, published_at, platforms, analysis_status
    from research_ads
    where organization_id = ${organizationId} and brand_id = ${brandId}
    order by captured_at desc
    limit 80
  `;
  const now = new Date().toISOString();
  let count = 0;
  for (const ad of ads) {
    const timeline = buildAdTimeline({
      sightings: [
        {
          seenAt: String(ad.published_at || ad.captured_at),
          platforms: parseList(ad.platforms),
          countries: [],
          reachLow: null,
          reachHigh: null,
          stillRunning: true,
        },
      ],
      now,
    });
    if (!timeline) continue;
    const scored = winnerScore({
      daysRunning: timeline.daysRunning,
      stillRunning: timeline.stillRunning,
      iterationCount: Math.max(1, timeline.siblingVariants),
      countries: timeline.countries.length,
      platforms: timeline.platforms.length,
      advertiserSurvivorRate: null,
      creativeQuality: ad.analysis_status === "analyzed" ? 0.45 : null,
    });
    const id = `tl:${brandId}:${ad.id}`;
    await sql`
      insert into ad_timelines (
        id, organization_id, brand_id, research_ad_id, first_seen, last_seen, still_running, days_running,
        sibling_variants, platforms, countries, reach_low, reach_high, winner_score, winner_low, winner_high, evidence
      ) values (
        ${id}, ${organizationId}, ${brandId}, ${ad.id}, ${timeline.firstSeen}, ${timeline.lastSeen}, ${timeline.stillRunning},
        ${timeline.daysRunning}, ${timeline.siblingVariants}, ${JSON.stringify(timeline.platforms)}, ${JSON.stringify(timeline.countries)},
        ${timeline.reachLow}, ${timeline.reachHigh}, ${scored.score}, ${scored.low}, ${scored.high}, ${JSON.stringify(scored.evidence)}
      )
      on conflict (organization_id, brand_id, research_ad_id) do update set
        last_seen = excluded.last_seen, still_running = excluded.still_running, days_running = excluded.days_running,
        platforms = excluded.platforms, countries = excluded.countries, winner_score = excluded.winner_score,
        winner_low = excluded.winner_low, winner_high = excluded.winner_high, evidence = excluded.evidence, updated_at = now()
    `;
    count += 1;
  }
  return count;
}

async function persistTemplates(sql: Sql, organizationId: string, brandId: string, runId: string): Promise<number> {
  const rows = await sql<{ research_ad_id: string; record: string }>`
    select research_ad_id, record from creative_dna
    where organization_id = ${organizationId} and brand_id = ${brandId}
    order by created_at desc
    limit 10
  `;
  let count = 0;
  for (const row of rows) {
    let dna: CreativeDna;
    try {
      dna = JSON.parse(row.record) as CreativeDna;
    } catch {
      continue;
    }
    if (!dna?.adId) continue;
    const template = templateFromDna(dna);
    const id = `tpl:${runId}:${row.research_ad_id}`;
    await sql`
      insert into factory_templates (id, organization_id, brand_id, source_ad_id, storyboard)
      values (${id}, ${organizationId}, ${brandId}, ${row.research_ad_id}, ${JSON.stringify(template)})
      on conflict (id) do update set storyboard = excluded.storyboard
    `;
    count += 1;
  }
  return count;
}

async function persistVariants(sql: Sql, organizationId: string, brandId: string, runId: string): Promise<number> {
  const templates = await sql<{ id: string }>`
    select id from factory_templates
    where organization_id = ${organizationId} and brand_id = ${brandId} and id like ${`tpl:${runId}:%`}
    order by created_at desc
    limit 5
  `;
  const axes = variantMatrix({
    hooks: ["question", "pattern interrupt"],
    ctas: ["shop", "learn"],
    presenters: ["founder"],
    lengthsMs: [9000, 15000],
    max: 8,
  });
  let count = 0;
  for (const template of templates) {
    for (const axis of axes) {
      const id = `var:${template.id}:${axis.hook}:${axis.cta}:${axis.presenter}:${axis.lengthMs}`;
      await sql`
        insert into factory_variants (id, organization_id, brand_id, template_id, hook, cta, presenter, length_ms, gate_result)
        values (${id.slice(0, 180)}, ${organizationId}, ${brandId}, ${template.id}, ${axis.hook}, ${axis.cta}, ${axis.presenter}, ${axis.lengthMs}, 'review')
        on conflict (id) do nothing
      `;
      count += 1;
    }
  }
  return count;
}

async function gateVariants(sql: Sql, organizationId: string, brandId: string): Promise<number> {
  const variants = await sql<{ id: string }>`
    select id from factory_variants
    where organization_id = ${organizationId} and brand_id = ${brandId}
    order by created_at desc
    limit 40
  `;
  let count = 0;
  for (const variant of variants) {
    const combined = combineGates([
      originalityGate({ frameHashDistance: null, embeddingDistance: null, textSimilarity: null }),
      brandGate({ logoPresent: null, paletteMatch: null, productLooksRight: null }),
      claimsGate({ claims: [], approvedClaims: [], bannedWords: [] }),
      policyGate({ beforeAfter: false, personalAttribute: false, healthClaim: false, financeClaim: false }),
      rightsGate({ musicLicensed: false, footageLicensed: false, aiLabeled: false }),
    ]);
    await sql`
      update factory_variants set gate_result = ${combined.result}
      where id = ${variant.id} and organization_id = ${organizationId} and brand_id = ${brandId}
    `;
    count += 1;
  }
  return count;
}

async function recordCost(sql: Sql, job: ExecutableJob, runId: string, stage: string, cents: number, seconds: number): Promise<void> {
  const id = `cost:${runId}:${stage}`;
  await sql`
    insert into factory_costs (id, organization_id, brand_id, run_id, stage, cents, seconds)
    values (${id}, ${job.organization_id}, ${job.brand_id}, ${runId}, ${stage}, ${Math.max(0, cents)}, ${Math.max(0, seconds)})
    on conflict (id) do update set cents = excluded.cents, seconds = excluded.seconds
  `;
}

async function killSwitchPaused(sql: Sql, organizationId: string, brandId: string): Promise<boolean> {
  const rows = await sql<{ scope: string; engaged: boolean }>`
    select scope, engaged from factory_kill_switches
    where organization_id = ${organizationId} and (brand_id is null or brand_id = ${brandId})
  `;
  return adsMustPause({
    workspaceEngaged: rows.some((row) => row.scope === "workspace" && row.engaged),
    brandEngaged: rows.some((row) => row.scope === "brand" && row.engaged),
  });
}

function guessFormat(source: string): AdFormat {
  const text = source.toLowerCase();
  if (text.includes("unbox")) return "unboxing";
  if (text.includes("testimonial") || text.includes("review")) return "testimonial";
  if (text.includes("how to") || text.includes("demo")) return "demo";
  if (text.includes("skit")) return "skit";
  return "other";
}
