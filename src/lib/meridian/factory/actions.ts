import { createServerFn } from "@tanstack/react-start";
import { sourceKeyFor } from "../sources/credentials.ts";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertRole, isRole, type Role } from "@/lib/meridian/access";
import { modelLimit, refuseIfLimited } from "@/lib/meridian/security/limits";
import { FACTORY_GRAPH } from "./pipeline.ts";
import { factoryRunJobs } from "./pipeline.ts";
import {
  parseFactoryLevel,
  FACTORY_LEVEL_DETAIL,
  FACTORY_LEVEL_LABELS,
  assertAutopilotLevelAllowed,
  type FactoryLevel,
} from "./autopilot.ts";
import { assertBrandInWorkspace, killSwitchCommand } from "./kill-switch.ts";
import { FACTORY_SOURCES, snapshotMediaAllowed } from "./sources.ts";
import { winnerScore } from "./winner-score.ts";
import { buildAdTimeline } from "./timeline.ts";
import { trendReport } from "./trends.ts";
import { weeklyStrategistReport } from "./report.ts";
import { hypitVideoEngine } from "@/lib/meridian/video/engine";

function clip(value: unknown, max: number, label: string, required = false): string {
  if (typeof value !== "string") {
    if (!required && (value === undefined || value === null)) return "";
    throw new Error(`${label} must be text.`);
  }
  const trimmed = value.trim();
  if (required && !trimmed) throw new Error(`${label} is required.`);
  if (trimmed.length > max) throw new Error(`${label} is too long.`);
  return trimmed;
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid request.");
  return input as Record<string, unknown>;
}

async function requireBrand(userId: string, brandId: string, minimum: Role) {
  const sql = await getSql();
  const rows = await sql<{ organization_id: string }>`
    select organization_id from brands where id = ${brandId} and deleted_at is null limit 1
  `;
  const organizationId = rows[0]?.organization_id;
  if (!organizationId) throw new Error("Brand not found.");
  const members = await sql<{ role: string }>`
    select role from memberships where user_id = ${userId} and organization_id = ${organizationId} limit 1
  `;
  const role = members[0]?.role;
  if (!role || !isRole(role)) throw new Error("That workspace is not available to you.");
  assertRole(role, minimum);
  return { sql, organizationId, role };
}

export const getFactoryBoard = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ brandId: clip(objectInput(input).brandId, 80, "Brand", true) }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { sql, organizationId, role } = await requireBrand(context.userId, data.brandId, "viewer");
    const ads = await sql<{
      id: string;
      advertiser: string;
      captured_at: unknown;
      published_at: unknown;
      platforms: string;
      media_status: string;
      transcript_status: string;
      analysis_status: string;
      copy: string;
    }>`
      select id, advertiser, captured_at, published_at, platforms, media_status, transcript_status, analysis_status, copy
      from research_ads
      where organization_id = ${organizationId} and brand_id = ${data.brandId}
      order by captured_at desc
      limit 80
    `;
    const runs = await sql<{ id: string; status: string; current_stage: string; niche: string; error: string; created_at: unknown }>`
      select id, status, current_stage, niche, error, created_at from factory_runs
      where organization_id = ${organizationId} and brand_id = ${data.brandId}
      order by created_at desc
      limit 8
    `;
    const settings = await sql<{ level: number; ceiling: number }>`
      select level, ceiling from factory_settings
      where organization_id = ${organizationId} and brand_id = ${data.brandId}
      limit 1
    `;
    const caps = await sql<{ daily_cents: number; total_cents: number }>`
      select daily_cents, total_cents from factory_spend_caps
      where organization_id = ${organizationId} and brand_id = ${data.brandId}
      limit 1
    `;
    const kill = await sql<{ scope: string; engaged: boolean }>`
      select scope, engaged from factory_kill_switches
      where organization_id = ${organizationId} and (brand_id is null or brand_id = ${data.brandId})
    `;
    const templates = await sql<{ id: string; source_ad_id: string; storyboard: string; created_at: unknown }>`
      select id, source_ad_id, storyboard, created_at from factory_templates
      where organization_id = ${organizationId} and brand_id = ${data.brandId}
      order by created_at desc
      limit 20
    `;
    const variants = await sql<{ id: string; hook: string; cta: string; presenter: string; length_ms: number; gate_result: string }>`
      select id, hook, cta, presenter, length_ms, gate_result from factory_variants
      where organization_id = ${organizationId} and brand_id = ${data.brandId}
      order by created_at desc
      limit 40
    `;
    const costs = await sql<{ stage: string; cents: number; seconds: number }>`
      select stage, cents, seconds from factory_costs
      where organization_id = ${organizationId} and brand_id = ${data.brandId}
      order by created_at desc
      limit 40
    `;
    const yieldRows = await sql<{
      search_terms: string;
      collected_count: number;
      analyzed_count: number;
      videos_downloaded: number;
      transcripts_produced: number;
      snapshot_without_video: number;
    }>`
      select search_terms, collected_count, analyzed_count, videos_downloaded, transcripts_produced, snapshot_without_video
      from research_collection_runs
      where organization_id = ${organizationId} and brand_id = ${data.brandId}
      order by created_at desc
      limit 10
    `;
    const timelines = await sql<{
      research_ad_id: string;
      days_running: number;
      still_running: boolean;
      sibling_variants: number;
      platforms: string;
      countries: string;
      winner_score: number | null;
      winner_low: number | null;
      winner_high: number | null;
      evidence: string;
    }>`
      select research_ad_id, days_running, still_running, sibling_variants, platforms, countries, winner_score, winner_low, winner_high, evidence
      from ad_timelines
      where organization_id = ${organizationId} and brand_id = ${data.brandId}
    `;
    const timelineByAd = new Map(timelines.map((row) => [row.research_ad_id, row]));
    const winners = ads.slice(0, 10).map((ad) => {
      const stored = timelineByAd.get(ad.id);
      if (stored && stored.winner_score != null && stored.winner_low != null && stored.winner_high != null) {
        return {
          id: ad.id,
          advertiser: ad.advertiser,
          copy: ad.copy.slice(0, 180),
          mediaStatus: ad.media_status,
          analysisStatus: ad.analysis_status,
          score: stored.winner_score,
          low: stored.winner_low,
          high: stored.winner_high,
          evidence: parseList(stored.evidence),
        };
      }
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
        now: new Date().toISOString(),
      });
      const score = winnerScore({
        daysRunning: timeline?.daysRunning ?? 0,
        stillRunning: true,
        iterationCount: 1,
        countries: timeline?.countries.length ?? 0,
        platforms: timeline?.platforms.length ?? 0,
        advertiserSurvivorRate: null,
        creativeQuality: ad.analysis_status === "analyzed" ? 0.45 : null,
      });
      return {
        id: ad.id,
        advertiser: ad.advertiser,
        copy: ad.copy.slice(0, 180),
        mediaStatus: ad.media_status,
        analysisStatus: ad.analysis_status,
        score: score.score,
        low: score.low,
        high: score.high,
        evidence: score.evidence,
      };
    });
    const thisWeek = new Date().toISOString().slice(0, 10);
    const prev = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const trends = trendReport({
      ads: ads.map((ad) => ({
        id: ad.id,
        concept: conceptFromCopy(ad.copy),
        advertiser: ad.advertiser,
        week: String(ad.captured_at).slice(0, 10),
        niche: "stored",
      })),
      thisWeek,
      prevWeek: prev,
      brandConcepts: [],
    });
    const report = weeklyStrategistReport({
      week: thisWeek,
      winners: winners.map((item) => ({
        label: item.advertiser,
        score: { score: item.score, low: item.low, high: item.high, evidence: item.evidence, components: {} },
      })),
      trends,
      queuedTemplates: [],
    });
    const level = (settings[0]?.level ?? 0) as FactoryLevel;
    const ceiling = (settings[0]?.ceiling ?? 1) as FactoryLevel;
    const video = hypitVideoEngine().status();
    const libraryToken = (await sourceKeyFor("meta_ad_library", organizationId)).secret !== null;
    return {
      role,
      organizationId,
      level,
      ceiling,
      levelLabel: FACTORY_LEVEL_LABELS[level],
      levelDetail: FACTORY_LEVEL_DETAIL[level],
      stages: FACTORY_GRAPH,
      sources: FACTORY_SOURCES.map((source) => ({
        ...source,
        connected: source.id === "meta_ad_library" ? libraryToken : false,
      })),
      snapshotMediaEnabled: snapshotMediaAllowed(),
      video,
      libraryStatus: libraryToken ? "CONFIGURED" : "NOT_CONNECTED",
      libraryError: libraryToken ? "" : "META_AD_LIBRARY_TOKEN is not configured. No ads were collected.",
      runs: runs.map((row) => ({
        id: row.id,
        status: row.status,
        stage: row.current_stage,
        niche: row.niche,
        error: row.error,
        createdAt: String(row.created_at),
      })),
      winners,
      trends,
      report,
      yieldRows: yieldRows.map((row) => ({
        niche: row.search_terms,
        adsFound: row.collected_count,
        videosDownloaded: row.videos_downloaded,
        transcriptsProduced: row.transcripts_produced,
        analysesCompleted: row.analyzed_count,
        snapshotWithoutVideo: row.snapshot_without_video,
      })),
      cap: caps[0] ? { dailyCents: caps[0].daily_cents, totalCents: caps[0].total_cents } : { dailyCents: 0, totalCents: 0 },
      killSwitch: {
        workspace: kill.some((row) => row.scope === "workspace" && row.engaged),
        brand: kill.some((row) => row.scope === "brand" && row.engaged),
      },
      templates: templates.map((row) => ({
        id: row.id,
        sourceAdId: row.source_ad_id,
        storyboard: row.storyboard,
        createdAt: String(row.created_at),
      })),
      variants: variants.map((row) => ({
        id: row.id,
        hook: row.hook,
        cta: row.cta,
        presenter: row.presenter,
        lengthMs: row.length_ms,
        gateResult: row.gate_result,
      })),
      costs: costs.map((row) => ({ stage: row.stage, cents: row.cents, seconds: row.seconds })),
      note: ads.length
        ? "Scores and trends below use stored Ad Library rows only. They are not live account results."
        : "No tracked ads yet. Connect Ad Library, a first-party account, or upload a swipe file. Nothing is invented to fill this board.",
    };
  });

export const startFactoryRun = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    const level = parseFactoryLevel(body.level) ?? 0;
    return {
      brandId: clip(body.brandId, 80, "Brand", true),
      niche: clip(body.niche, 80, "Niche", true),
      level,
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    refuseIfLimited(modelLimit, context.userId);
    const { sql, organizationId } = await requireBrand(context.userId, data.brandId, "member");
    const settings = await sql<{ ceiling: number }>`
      select ceiling from factory_settings where organization_id = ${organizationId} and brand_id = ${data.brandId} limit 1
    `;
    const ceiling = (settings[0]?.ceiling ?? 1) as FactoryLevel;
    if (data.level > ceiling) throw new Error("That autopilot level is above the owner ceiling for this brand.");
    if (data.level > 1) {
      await assertAutopilotLevelAllowed(sql, data.brandId, data.level);
    }
    const runId = crypto.randomUUID();
    await sql`
      insert into factory_runs (id, organization_id, brand_id, niche, level, status, current_stage, created_by)
      values (${runId}, ${organizationId}, ${data.brandId}, ${data.niche}, ${data.level}, 'queued', 'factory.discover', ${context.userId})
    `;
    const jobs = factoryRunJobs({ organizationId, brandId: data.brandId, runId, niche: data.niche, level: data.level });
    const idByKey = new Map<string, string>();
    for (const job of jobs) {
      const id = crypto.randomUUID();
      idByKey.set(job.idempotencyKey, id);
      const dependsOn = job.dependsOnKey ? idByKey.get(job.dependsOnKey) ?? "" : "";
      await sql`
        insert into jobs (
          id, organization_id, brand_id, job_type, idempotency_key, status, payload, max_attempts, depends_on, priority
        ) values (
          ${id}, ${organizationId}, ${data.brandId}, ${job.jobType}, ${job.idempotencyKey}, 'queued',
          ${JSON.stringify(job.payload)}, ${job.maxAttempts}, ${dependsOn}, ${job.priority}
        )
        on conflict (organization_id, idempotency_key) do nothing
      `;
    }
    return { runId, status: "queued" as const, jobs: jobs.length };
  });

export const setFactoryControls = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    const level = parseFactoryLevel(body.level);
    const ceiling = parseFactoryLevel(body.ceiling);
    const dailyCents = Number(body.dailyCents);
    const totalCents = Number(body.totalCents);
    if (level == null || ceiling == null) throw new Error("Choose factory levels 0–3.");
    if (!Number.isInteger(dailyCents) || !Number.isInteger(totalCents) || dailyCents < 0 || totalCents < 0) {
      throw new Error("Spend caps must be whole cents.");
    }
    return { brandId: clip(body.brandId, 80, "Brand", true), level, ceiling, dailyCents, totalCents };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { sql, organizationId } = await requireBrand(context.userId, data.brandId, "owner");
    if (data.level > data.ceiling) throw new Error("The running level cannot exceed the ceiling.");
    const targetLevel = Math.max(data.level, data.ceiling) as FactoryLevel;
    if (targetLevel > 1) {
      await assertAutopilotLevelAllowed(sql, data.brandId, targetLevel);
    }
    await sql`
      insert into factory_settings (organization_id, brand_id, level, ceiling, updated_by)
      values (${organizationId}, ${data.brandId}, ${data.level}, ${data.ceiling}, ${context.userId})
      on conflict (organization_id, brand_id) do update set level = excluded.level, ceiling = excluded.ceiling, updated_by = excluded.updated_by, updated_at = now()
    `;
    await sql`
      insert into factory_spend_caps (organization_id, brand_id, daily_cents, total_cents, updated_by)
      values (${organizationId}, ${data.brandId}, ${data.dailyCents}, ${data.totalCents}, ${context.userId})
      on conflict (organization_id, brand_id) do update set daily_cents = excluded.daily_cents, total_cents = excluded.total_cents, updated_by = excluded.updated_by, updated_at = now()
    `;
    return { ok: true as const };
  });

export const setKillSwitch = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return {
      brandId: clip(body.brandId, 80, "Brand", false),
      organizationId: clip(body.organizationId, 80, "Workspace", true),
      engage: body.engage === true,
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const members = await sql<{ role: string }>`
      select role from memberships where user_id = ${context.userId} and organization_id = ${data.organizationId} limit 1
    `;
    const role = members[0]?.role;
    if (!role || !isRole(role)) throw new Error("That workspace is not available to you.");
    assertRole(role, "admin");
    if (data.brandId) await assertBrandInWorkspace(sql, data.organizationId, data.brandId);
    const event = killSwitchCommand({
      organizationId: data.organizationId,
      brandId: data.brandId || null,
      engage: data.engage,
      actorId: context.userId,
    });
    if (event.brandId) {
      await sql`delete from factory_kill_switches where organization_id = ${event.organizationId} and brand_id = ${event.brandId}`;
      await sql`
        insert into factory_kill_switches (organization_id, brand_id, scope, engaged, actor_id)
        values (${event.organizationId}, ${event.brandId}, 'brand', ${event.engaged}, ${event.actorId})
      `;
    } else {
      await sql`delete from factory_kill_switches where organization_id = ${event.organizationId} and brand_id is null`;
      await sql`
        insert into factory_kill_switches (organization_id, brand_id, scope, engaged, actor_id)
        values (${event.organizationId}, null, 'workspace', ${event.engaged}, ${event.actorId})
      `;
    }
    return { ok: true as const, engaged: event.engaged, scope: event.scope };
  });

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function conceptFromCopy(copy: string): string {
  const text = copy.trim().toLowerCase();
  if (!text) return "unspecified";
  return text.split(/\s+/).slice(0, 4).join(" ");
}
