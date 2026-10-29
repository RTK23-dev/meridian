// The session loading block of studio/session.server.ts: the stored session of a brand, its run policy and its usage.
// Moved out unchanged (coding loop, T4). studio/session.server.ts re-exports every public name it had.

import { getSql } from "../../db.ts";
import { assertRole, isRole, type Role } from "../access.ts";
import { parseFrame } from "../brief/frame.ts";
import { loadBrandContext } from "../context/load.ts";
import type { Sql } from "../learning/store.ts";
import { learningDirection } from "../learning/engine.ts";
import { fingerprintCreative } from "../intelligence/fingerprint.ts";
import { findWhitespace } from "../intelligence/whitespace.ts";
import { rankOpportunities, recommendationPosture } from "../opportunity/engine.ts";
import { isTestingRuntime } from "./media-work.ts";
import { ensureLocalSemantic } from "../embeddings/store.ts";
import type { MarketCluster } from "../intelligence/whitespace.ts";
import type { AutonomyMode } from "../creative/plan.ts";
import { isAutomationLevel } from "../brain.ts";
import { brandAutomationDefault, parseStoredSettings, studioAutonomyOfAutomation } from "../factory/run-settings.ts";

function answerValue(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "";
  try {
    const parsed = JSON.parse(raw) as { value?: unknown };
    return typeof parsed.value === "string" ? parsed.value : "";
  } catch {
    return "";
  }
}

export function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function asNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** A stored probability, or null when none is stored. A missing probability is unknown, never 0. */
export function storedProbability(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function asJson<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  if (value && typeof value === "object") return value as T;
  return fallback;
}

export async function requireBrand(sql: Sql, userId: string, brandId: string, minimum: Role) {
  const brands = await sql<{ organization_id: string }>`
    select organization_id from brands where id = ${brandId} and deleted_at is null limit 1
  `;
  const organizationId = brands[0]?.organization_id ?? "";
  if (!organizationId) throw new Error("Brand not found.");
  const members = await sql<{ role: string }>`
    select role from memberships where user_id = ${userId} and organization_id = ${organizationId} limit 1
  `;
  const role = members[0]?.role;
  if (!role || !isRole(role)) throw new Error("That workspace is not available to you.");
  assertRole(role, minimum);
  return { organizationId, role };
}

/** Generation runs counted the way the gate counts them: runs in the last day, and runs in progress, for the workspace. */
export async function generationUsage(sql: Sql, organizationId: string): Promise<{ runsToday: number; running: number }> {
  const rows = await sql<{ runs_today: number; running: number }>`
    select
      count(*) filter (where created_at > now() - interval '1 day' and status in ('running', 'completed'))::int as runs_today,
      count(*) filter (where status = 'running')::int as running
    from generation_runs
    where organization_id = ${organizationId}
  `;
  return { runsToday: asNumber(rows[0]?.runs_today), running: asNumber(rows[0]?.running) };
}

export async function loadSession(sql: Sql, organizationId: string, brandId: string, role: Role) {
  const loaded = await loadBrandContext(sql, organizationId, brandId);
  let clusters: MarketCluster[] = [];
  let semantic: { note: string; clusters: { id: string; label: string; summary: string; competitorCount: number; ownCount: number }[] } = {
    note: "local:semantic did not run.",
    clusters: [],
  };
  try {
    const embedded = await ensureLocalSemantic(
      sql,
      organizationId,
      brandId,
      loaded.creatives.map((creative) => ({
        id: creative.id,
        origin: creative.origin,
        angle: creative.angle,
        text: creative.text,
      })),
    );
    clusters = embedded.clusters;
    semantic = {
      note: embedded.note,
      clusters: embedded.clusters.map((cluster) => ({
        id: cluster.id,
        label: cluster.label,
        summary: cluster.summary,
        competitorCount: cluster.competitorCount,
        ownCount: cluster.ownCount,
      })),
    };
  } catch (error) {
    semantic = {
      note: error instanceof Error ? error.message : "local:semantic failed. No cluster was invented.",
      clusters: [],
    };
  }
  const ranked = rankOpportunities({ organizationId, brandId, ...loaded, clusters });
  const discovered = ranked.filter((item) => item.source === "discovered");
  const top = discovered[0] ?? null;
  const exploration = ranked.find((item) => item.source === "prior") ?? null;
  const fingerprints = loaded.creatives.map((creative) => fingerprintCreative(creative, loaded.brain));
  const whitespace = findWhitespace({
    fingerprints,
    origins: loaded.creatives.map((creative) => ({ id: creative.id, origin: creative.origin })),
    brandText: `${loaded.brain.positioning} ${loaded.brain.valueProposition}`,
    clusters,
  });
  const stored = await sql<Record<string, unknown>>`
    select o.id, o.hypothesis_id, o.status, o.angle, d.decision, d.probability,
           r.id as review_id
    from opportunities o
    left join jev_decisions d on d.id = o.decision_id
    left join reviews r on r.opportunity_id = o.id and r.status = 'open'
    where o.brand_id = ${brandId} and o.organization_id = ${organizationId}
      and o.status in ('open', 'briefed')
    order by o.expected_value desc
  `;
  const match = top
    ? stored.find((row) => asText(row.angle) === top.angle && asText(row.status) === "open") ??
      stored.find((row) => asText(row.angle) === top.angle)
    : undefined;
  const posture = top
    ? recommendationPosture({
        source: top.source,
        historicalEvidence: top.historicalEvidence,
        confidence: top.confidence,
        novelty: top.novelty,
      })
    : null;
  const briefs = await sql<Record<string, unknown>>`
    select id, title, audience, angle, hook, message, offer, cta, format, proof_type, constraints, why,
           learning_notes, failure_notes, status, opportunity_id, frame, created_at
    from briefs
    where brand_id = ${brandId} and organization_id = ${organizationId}
    order by created_at desc
    limit 6
  `;
  // status is the stored-file state: 'stored' is served by /api/assets/<id>, 'unavailable' is not.
  const assets = await sql<Record<string, unknown>>`
    select a.id as asset_id, a.creative_id, a.kind, a.mime_type, a.byte_size, a.width, a.height, a.duration_ms,
           a.provider, a.model, a.prompt_version, a.generation_run_id, a.checksum, a.media_status, a.qa_decision,
           a.review_status, a.transcript, a.scenes, a.provider_job_id, a.variant_index, a.status as asset_status, a.error,
           c.title, c.status as creative_status, c.angle, c.hook, c.raw_text, c.brief_id
    from assets a
    join creative_records c on c.id = a.creative_id
    where a.brand_id = ${brandId} and a.organization_id = ${organizationId}
      and a.kind in ('image', 'video')
    order by a.created_at asc
  `;
  const creativeIds = assets.map((row) => asText(row.creative_id)).filter(Boolean);
  const decisions = creativeIds.length
    ? await sql<Record<string, unknown>>`
        select id, subject_id, question_id, decision, probability, confidence, reasons, evidence, answer
        from jev_decisions
        where brand_id = ${brandId} and organization_id = ${organizationId} and subject_type = 'creative'
      `
    : [];
  const reviews = await sql<Record<string, unknown>>`
    select id, creative_id, status from reviews
    where brand_id = ${brandId} and organization_id = ${organizationId} and creative_id is not null
  `;
  // Image bytes and video stills are not in the payload. The screen loads them from /api/assets/<assetId>, which checks
  // the session and the workspace, and a video poster from ?thumb=1.
  const publications = await sql<{ external_id: string; idempotency_key: string; provider: string }>`
    select external_id, idempotency_key, provider from provider_objects
    where brand_id = ${brandId} and organization_id = ${organizationId} and object_type = 'ad'
  `;
  const briefOf = (row: Record<string, unknown>) => ({
    id: asText(row.id),
    title: asText(row.title),
    audience: asText(row.audience),
    angle: asText(row.angle),
    hook: asText(row.hook),
    promise: asText(row.message),
    offer: asText(row.offer),
    cta: asText(row.cta),
    format: asText(row.format),
    proofType: asText(row.proof_type),
    constraints: asText(row.constraints),
    why: asJson<string[]>(row.why, []),
    learningNotes: asJson<string[]>(row.learning_notes, []),
    failureNotes: asJson<string[]>(row.failure_notes, []),
    status: asText(row.status),
    opportunityId: asText(row.opportunity_id),
    frame: parseFrame(row.frame),
  });
  return {
    role,
    // The server decides whether the placeholder image provider is offered. Production hides it.
    testImageAllowed: isTestingRuntime(),
    observationCount: loaded.creatives.filter((item) => item.origin === "competitor").length,
    recommendation: top
      ? {
          angle: top.angle,
          label: top.label,
          source: "discovered" as const,
          reason: top.reason,
          expectedValue: top.expectedValue,
          confidence: top.confidence,
          marketSignal: top.marketSignal,
          novelty: top.novelty,
          brandFit: top.brandFit,
          saturation: top.saturation,
          historicalEvidence: top.historicalEvidence,
          evidence: top.evidence.map((item) => item.summary),
          opportunityId: match ? asText(match.id) : "",
          decision: match ? asText(match.decision) : "",
          probability: match ? storedProbability(match.probability) : null,
          reviewId: match ? asText(match.review_id) : "",
          posture: posture?.posture ?? "exploration",
          because: posture?.because ?? "",
          uncertainty: posture?.uncertainty ?? "",
        }
      : null,
    exploration: exploration
      ? { label: exploration.label, angle: exploration.angle, reason: exploration.reason }
      : null,
    whitespace: whitespace.map((item) => ({ id: item.id, underused: item.underused, overused: item.overused, whyTest: item.whyTest })),
    briefs: briefs.map(briefOf),
    brief: briefs[0] ? briefOf(briefs[0]) : null,
    variants: assets.map((row) => {
      const creativeId = asText(row.creative_id);
      const questions = decisions
        .filter((item) => asText(item.subject_id) === creativeId)
        .map((item) => ({
          id: asText(item.question_id),
          decision: asText(item.decision),
          probability: asNumber(item.probability),
          confidence: asNumber(item.confidence),
          reasons: asJson<string[]>(item.reasons, []),
          evidence: asJson<{ summary: string }[]>(item.evidence, []).map((entry) => entry.summary),
          answer: answerValue(item.answer),
        }));
      const review = reviews.find((item) => asText(item.creative_id) === creativeId && asText(item.status) === "open");
      return {
        creativeId,
        assetId: asText(row.asset_id),
        // 'stored' means /api/assets/<assetId> serves the file. Any other value means the file is not stored yet.
        assetStatus: asText(row.asset_status),
        kind: asText(row.kind),
        index: asNumber(row.variant_index),
        provider: asText(row.provider),
        model: asText(row.model),
        promptVersion: asText(row.prompt_version),
        generationRunId: asText(row.generation_run_id),
        mediaStatus: asText(row.media_status),
        qaDecision: asText(row.qa_decision),
        reviewStatus: asText(row.review_status) || asText(row.creative_status),
        creativeStatus: asText(row.creative_status),
        reviewId: review ? asText(review.id) : "",
        width: row.width == null ? null : asNumber(row.width),
        height: row.height == null ? null : asNumber(row.height),
        durationMs: row.duration_ms == null ? null : asNumber(row.duration_ms),
        transcript: asText(row.transcript),
        scenes: asJson<{ atMs: number; summary: string }[]>(row.scenes, []),
        checksum: asText(row.checksum),
        byteSize: asNumber(row.byte_size),
        title: asText(row.title),
        error: asText(row.error),
        questions,
      };
    }),
    // The same counts generationAllowed checks, for the workspace. The Generate step draws its meters from these.
    usage: await generationUsage(sql, organizationId),
    learned: loaded.patterns.slice(0, 8).map((pattern) => ({
      summary: pattern.summary,
      lift: pattern.lift,
      attribute: pattern.attribute,
      value: pattern.value,
      sampleSize: pattern.sampleSize,
      impressions: pattern.impressions,
      state: pattern.state ?? "INFERRED",
      direction: learningDirection(pattern),
    })),
    rejections: loaded.rejections.map((fact) => `${fact.reasonCode} × ${fact.count}`),
    semantic,
    publications: publications.map((row) => ({
      creativeId: row.idempotency_key,
      externalId: row.external_id,
      provider: row.provider,
    })),
  };
}

export type StudioSession = Awaited<ReturnType<typeof loadSession>>;

async function sessionFor(sql: Sql, userId: string, brandId: string, minimum: Role) {
  const access = await requireBrand(sql, userId, brandId, minimum);
  return { access, session: await loadSession(sql, access.organizationId, brandId, access.role) };
}

export async function getStudioSession(userId: string, data: { brandId: string }) {
  const context = { userId };
    const sql = await getSql();
    const { access, session } = await sessionFor(sql, context.userId, data.brandId, "viewer");
    return { ...session, autonomyDefault: await studioAutonomyDefault(sql, access.organizationId, data.brandId) };
}

/**
 * The brand's Studio run policy. The autonomy a plan starts from is the brand's automation default: its saved run defaults, else its
 * brain's automation level, so Studio and the Factory start from the same setting. The ceiling is the brand's saved total spend cap
 * (run defaults caps.totalCents), or null when the brand has not set one. No plan may ask for more than the ceiling.
 */
export async function studioBrandRunPolicy(
  sql: Sql,
  organizationId: string,
  brandId: string,
): Promise<{ autonomy: AutonomyMode; ceilingUsd: number | null }> {
  const rows = await sql<{ run_defaults: string | null; automation_level: string | null }>`
    select b.run_defaults, bb.automation_level
    from brands b
    left join brand_brains bb on bb.brand_id = b.id
    where b.id = ${brandId} and b.organization_id = ${organizationId}
    limit 1
  `;
  const row = rows[0];
  const brainLevel = row?.automation_level && isAutomationLevel(row.automation_level) ? row.automation_level : "manual";
  const autonomy = studioAutonomyOfAutomation(brandAutomationDefault({ runDefaults: row?.run_defaults, brainLevel }));
  const totalCents = parseStoredSettings(row?.run_defaults)?.caps.totalCents ?? 0;
  return { autonomy, ceilingUsd: totalCents > 0 ? totalCents / 100 : null };
}

/** The autonomy a Studio plan starts from when the person does not choose one. See studioBrandRunPolicy. */
export async function studioAutonomyDefault(sql: Sql, organizationId: string, brandId: string): Promise<AutonomyMode> {
  return (await studioBrandRunPolicy(sql, organizationId, brandId)).autonomy;
}

