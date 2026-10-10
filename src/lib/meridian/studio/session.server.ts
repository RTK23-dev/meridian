import { getSql } from "../../db.ts";
import { assertRole, isRole, type Role } from "../access.ts";
import { buildBrief } from "../brief/engine.ts";
import { loadBrandContext } from "../context/load.ts";
import { assertSameTenant } from "../domain.ts";
import type { Sql } from "../learning/store.ts";
import { applyLearnedPatterns } from "../learning/store.ts";
import { learningDirection } from "../learning/engine.ts";
import { fingerprintCreative } from "../intelligence/fingerprint.ts";
import { findWhitespace } from "../intelligence/whitespace.ts";
import { hypothesisById } from "../opportunity/catalog.ts";
import { rankOpportunities, recommendationPosture, type OpportunityDraft } from "../opportunity/engine.ts";
import { rerankBrand } from "../opportunity/rerank.ts";
import { publishThrough } from "../providers/boundaries.ts";
import { testProviderPerformance } from "../providers/test-provider.ts";
import { claimAndRun } from "../jobs/sql-worker.ts";
import { decide } from "../jev/engine.ts";
import { publishingReadiness } from "../jev/guards.ts";
import { generationAllowed } from "../security/budget.ts";
import { evaluateJevGate } from "../jev/reviewer-decision.ts";
import { ruleDecisionRecordFields } from "../jev/decision-record.ts";
import { judgeBriefFit, writeBriefDecision } from "./brief-gate.server.ts";
import { briefStatusFor } from "./brief-review.server.ts";
import { STUDIO_PROMPT_VERSION, isTestingRuntime, variantPrompt } from "./media-work.ts";
import { publishStudioHypitVideo } from "./hypit-run.ts";
import { productionRouter, type ImageProviderSelection } from "../production/router.ts";
import { ensureLocalSemantic, readSemanticClusters, semanticNearest } from "../embeddings/store.ts";
import { assessPublishing } from "../publishing/readiness.ts";
import { combineLogoFrames, combinePaletteFrames } from "../vision/measure.ts";
import type { MarketCluster } from "../intelligence/whitespace.ts";
import { CreativeDecisionEngine } from "../creative/engine.ts";
import type { CreationScope, AutonomyMode, CreativePlan } from "../creative/plan.ts";
import { finalizeProductionArtifact } from "../production/artifact-finalizer.ts";
import { defaultArtifactDrive } from "../storage/artifact-drive.ts";
import { BudgetLedgerService, InvalidBudgetCapError, toMicros } from "../security/budget-ledger.ts";
import { modelCapabilityRegistry } from "../production/registry.ts";
import {
  completeProductionJob,
  ESTIMATOR_VERSION,
  openProductionReview,
  settleCreativePlanIfComplete,
  settleCarouselParent,
  settleProductionReservation,
} from "../production/materialization.ts";
import type { ImageGenerationOutcome } from "../production/image-providers.ts";
import type { CreativeSpec } from "../production/types.ts";
import { creativeSpecFromManifest } from "../production/spec-from-manifest.ts";
import { resolveProductionTarget } from "../production/target.ts";
import { transitionCreativePlan } from "../creative/state-transition.server.ts";
import { creativeJudgmentsFromStoredDecision } from "./jev-context.ts";
import { accountSnapshots, competitorCopy, factsFor, frameLike, qcBrandOf, videoVisualEvidence, visualFacts, writeJudgment } from "./image-qc.server.ts";
import { resolveActiveEngine } from "../decisions/selection.ts";
import { selectPerceptionProvider } from "../perception/run.ts";
import { isTestingRuntimeNow } from "../runtime-mode.ts";

function answerValue(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "";
  try {
    const parsed = JSON.parse(raw) as { value?: unknown };
    return typeof parsed.value === "string" ? parsed.value : "";
  } catch {
    return "";
  }
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function asNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function asJson<T>(value: unknown, fallback: T): T {
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

async function requireBrand(sql: Sql, userId: string, brandId: string, minimum: Role) {
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

function hookFor(hypothesisId: string): string {
  return hypothesisById(hypothesisId)?.hookLine || "Keep the observed structure. Do not copy the competitor's wording.";
}

async function loadSession(sql: Sql, organizationId: string, brandId: string, role: Role) {
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
           learning_notes, failure_notes, status, opportunity_id, created_at
    from briefs
    where brand_id = ${brandId} and organization_id = ${organizationId}
    order by created_at desc
    limit 6
  `;
  const assets = await sql<Record<string, unknown>>`
    select a.id as asset_id, a.creative_id, a.kind, a.mime_type, a.byte_size, a.width, a.height, a.duration_ms,
           a.provider, a.model, a.prompt_version, a.generation_run_id, a.checksum, a.media_status, a.qa_decision,
           a.review_status, a.transcript, a.scenes, a.provider_job_id, a.variant_index, a.storage_key, a.error,
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
  const blobs = await sql<{ storage_key: string; body: string; mime_type: string }>`
    select storage_key, body, mime_type from asset_blobs
    where brand_id = ${brandId} and organization_id = ${organizationId} and mime_type like 'image/%'
  `;
  // Image previews come from the artifact store, where production writes image bytes. An artifact that cannot be read
  // has no preview, so nothing is shown in its place.
  const previewByKey = new Map<string, string>();
  const artifactDrive = defaultArtifactDrive();
  for (const asset of assets) {
    const key = asText(asset.storage_key);
    if (asText(asset.kind) !== "image" || !key || previewByKey.has(key)) continue;
    const objects = await sql<{ provider_file_id: string }>`
      select provider_file_id from storage_objects
      where organization_id = ${organizationId} and brand_id = ${brandId} and name = ${key}
      limit 1
    `;
    if (!objects[0]) continue;
    try {
      const stored = await artifactDrive.get(objects[0].provider_file_id);
      if (stored.bytes.byteLength < 120_000) {
        previewByKey.set(key, `data:${stored.mimeType};base64,${Buffer.from(stored.bytes).toString("base64")}`);
      }
    } catch {
      // Unreadable artifact: no preview.
    }
  }
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
          probability: match ? asNumber(match.probability) : 0,
          reviewId: match ? asText(match.review_id) : "",
          posture: posture?.posture ?? "exploration",
          because: posture?.because ?? "",
          uncertainty: posture?.uncertainty ?? "",
        }
      : null,
    exploration: exploration
      ? { label: exploration.label, angle: exploration.angle, reason: exploration.reason }
      : null,
    whitespace: whitespace.map((item) => ({ underused: item.underused, overused: item.overused, whyTest: item.whyTest })),
    briefs: briefs.map(briefOf),
    brief: briefs[0] ? briefOf(briefs[0]) : null,
    variants: assets.map((row) => {
      const creativeId = asText(row.creative_id);
      const preview = previewByKey.get(asText(row.storage_key)) ?? "";
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
      const storageKey = asText(row.storage_key);
      const frames = blobs
        .filter((blob) => storageKey && blob.storage_key.startsWith(`${storageKey}.frame.`) && blob.mime_type.startsWith("image/"))
        .sort((left, right) => left.storage_key.localeCompare(right.storage_key))
        .slice(0, 3)
        .map((blob) => `data:${blob.mime_type};base64,${blob.body}`);
      return {
        creativeId,
        assetId: asText(row.asset_id),
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
        preview,
        frames,
        error: asText(row.error),
        questions,
      };
    }),
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
    return (await sessionFor(sql, context.userId, data.brandId, "viewer")).session;
}

export async function openStudioBrief(userId: string, data: { brandId: string; forceNew: boolean }) {
  const context = { userId };
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    await rerankBrand(sql, access.organizationId, data.brandId);
    const loaded = await loadBrandContext(sql, access.organizationId, data.brandId);
    assertSameTenant(loaded.creatives, access.organizationId, data.brandId);
    let clusters: MarketCluster[] = [];
    try {
      clusters = (
        await readSemanticClusters(
          sql,
          access.organizationId,
          data.brandId,
          loaded.creatives.map((creative) => ({
            id: creative.id,
            origin: creative.origin,
            angle: creative.angle,
            text: creative.text,
          })),
        )
      ).clusters;
    } catch {
      clusters = [];
    }
    const ranked = rankOpportunities({ organizationId: access.organizationId, brandId: data.brandId, ...loaded, clusters });
    const top = ranked.find((item) => item.source === "discovered");
    if (!top) throw new Error("No discovered opportunity. Stored observations do not show a direction outside the exploration seeds.");
    const rows = await sql<Record<string, unknown>>`
      select o.*, d.decision
      from opportunities o
      left join jev_decisions d on d.id = o.decision_id
      where o.brand_id = ${data.brandId} and o.organization_id = ${access.organizationId}
        and o.angle = ${top.angle} and o.status = 'open'
      order by o.expected_value desc
      limit 1
    `;
    const row = rows[0];
    if (!row) throw new Error("The discovered direction was not stored. Refresh did not write it.");
    if (asText(row.decision) === "REJECT" || asText(row.status) === "rejected") {
      throw new Error("JEV rejected this direction. A brief was not written.");
    }
    const opportunityId = asText(row.id);
    await sql`
      update reviews set status = 'approved'
      where opportunity_id = ${opportunityId} and status = 'open' and organization_id = ${access.organizationId}
    `;
    await sql`
      update jev_decisions set reviewer_id = ${context.userId}, reviewer_decision = 'approve', reviewed_at = now()
      where id = ${asText(row.decision_id)} and organization_id = ${access.organizationId}
    `;
    if (data.forceNew) {
      await sql`
        update briefs set status = 'used'
        where opportunity_id = ${opportunityId} and status = 'ready' and organization_id = ${access.organizationId}
      `;
    }
    const existing = await sql<{ id: string; decision_id: string }>`
      select id, decision_id from briefs
      where opportunity_id = ${opportunityId} and status = 'ready' and organization_id = ${access.organizationId}
      order by created_at desc limit 1
    `;
    if (!existing[0]) {
      const draft: OpportunityDraft = {
        hypothesisId: asText(row.hypothesis_id),
        source: "discovered",
        label: asText(row.label),
        category: asText(row.category),
        angle: asText(row.angle),
        hookType: asText(row.hook_type),
        audience: asText(row.audience),
        format: asText(row.format),
        proofType: asText(row.proof_type),
        productId: row.product_id ? asText(row.product_id) : null,
        productName: asText(row.product_name) || loaded.products[0]?.name || "",
        marketSignal: asNumber(row.market_signal),
        novelty: asNumber(row.novelty_score),
        brandFit: asNumber(row.brand_fit_score),
        reproducibility: asNumber(row.reproducibility_score),
        risk: asNumber(row.risk_score),
        saturation: asNumber(row.saturation_score),
        historicalEvidence: asNumber(row.historical_score),
        expectedValue: asNumber(row.expected_value),
        rawScore: asNumber(row.raw_score),
        reason: asText(row.reason),
        evidence: asJson(row.evidence, []),
        evidenceBasis: asText(row.evidence_basis) as OpportunityDraft["evidenceBasis"],
        supportingCreativeIds: asJson(row.supporting_ids, []),
        confidence: asNumber(row.confidence),
        hookDirection: hookFor(asText(row.hypothesis_id)),
      };
      const documents = await sql<{ id: string; excerpt: string }>`
        select id, excerpt from source_documents
        where brand_id = ${data.brandId} and organization_id = ${access.organizationId} and status = 'stored'
        order by created_at desc
        limit 6
      `;
      const brief = buildBrief({
        opportunity: draft,
        brain: loaded.brain,
        patterns: loaded.patterns,
        rejections: loaded.rejections,
        observations: documents.map((document) => ({ id: document.id, text: document.excerpt })),
      });
      for (const pattern of loaded.patterns.filter((item) => item.lift < 0)) {
        const line = `Do not prefer ${pattern.attribute}=${pattern.value}.`;
        if (!brief.constraints.includes(line)) brief.constraints = `${brief.constraints}\n${line} ${pattern.summary}`.trim();
      }
      if (!brief.cta.trim()) brief.cta = "See it in use";
      brief.why.push("Success would test whether this direction beats this brand's stored baseline without copying a competitor line.");
      const briefId = crypto.randomUUID();
      const decisionId = crypto.randomUUID();
      const briefGate = await judgeBriefFit({
        sql,
        organizationId: access.organizationId,
        brandId: data.brandId,
        briefId,
        brief: {
          audience: brief.audience,
          hook: brief.hook,
          message: brief.message,
          format: brief.format,
          cta: brief.cta,
          angle: brief.angle,
        },
        brain: loaded.brain,
      });
      await writeBriefDecision(sql, {
        organizationId: access.organizationId,
        brandId: data.brandId,
        briefId,
        decisionId,
        result: briefGate,
      });
      if (briefGate.action === "REJECT") {
        throw new Error(`The brief gate rejected this: ${briefGate.reason}. A person was not asked to ignore a stored rejection.`);
      }
      // A brief the engine could not judge waits for an explicit review. Creating it is not that review.
      const briefStatus = briefStatusFor(briefGate.action);
      await sql`
        insert into briefs (
          id, organization_id, brand_id, opportunity_id, title, audience, angle, hook, message, offer, cta,
          format, proof_type, constraints, context_pack, workflow, why, learning_notes, failure_notes,
          status, decision_id, created_by
        ) values (
          ${briefId}, ${access.organizationId}, ${data.brandId}, ${opportunityId}, ${brief.title},
          ${brief.audience}, ${brief.angle}, ${brief.hook}, ${brief.message}, ${brief.offer}, ${brief.cta},
          ${brief.format}, ${brief.proofType}, ${brief.constraints}, ${JSON.stringify(brief.context)},
          ${JSON.stringify(brief.workflow)}, ${JSON.stringify(brief.why)}, ${JSON.stringify(brief.learningNotes)},
          ${JSON.stringify(brief.failureNotes)}, ${briefStatus}, ${decisionId}, ${context.userId}
        )
      `;
      await sql`update opportunities set status = 'briefed' where id = ${opportunityId}`;
    }
    return loadSession(sql, access.organizationId, data.brandId, access.role);
}

async function measuredVideoFrames(sql: Sql, organizationId: string, brandId: string, storageKey: string) {
  const missingLogo = {
    similarity: null,
    confidence: null,
    outcome: "ABSENT" as const,
    evidence: storageKey && !storageKey.startsWith("pending/")
      ? "The stored container had no extractable frame. Vision was not run and nothing was treated as a match."
      : "Video bytes are not stored yet. Vision was not run.",
  };
  const missingPalette = {
    distance: null,
    confidence: null,
    outcome: "ABSENT" as const,
    extracted: [] as string[],
    evidence: missingLogo.evidence,
  };
  if (!storageKey || storageKey.startsWith("pending/")) {
    return { measuredLogo: missingLogo, measuredPalette: missingPalette };
  }
  const rows = await sql<{ body: string }>`
    select body from asset_blobs
    where organization_id = ${organizationId} and brand_id = ${brandId}
      and storage_key like ${frameLike(storageKey)} escape '\\'
    order by storage_key asc
  `;
  const logos = [];
  const palettes = [];
  for (const row of rows) {
    const visual = await visualFacts(sql, organizationId, brandId, new Uint8Array(Buffer.from(row.body, "base64")));
    logos.push(visual.measuredLogo);
    palettes.push(visual.measuredPalette);
  }
  if (logos.length === 0) return { measuredLogo: missingLogo, measuredPalette: missingPalette };
  return { measuredLogo: combineLogoFrames(logos), measuredPalette: combinePaletteFrames(palettes) };
}

export { writeJudgment } from "./image-qc.server.ts";

/**
 * Inserts a new CreativePlan row. An existing row with the same id is never rewritten: lifecycle
 * status changes only through transitionCreativePlan, so a collision is refused instead.
 */
export async function persistCreativePlanRow(
  sql: Sql,
  input: { plan: CreativePlan; organizationId: string; brandId: string; briefId: string; maxSpendUsd?: number },
): Promise<void> {
  const { plan } = input;
  // A plan without lineage is refused before any write. The database trigger refuses it too (migration 0042).
  if (!plan.lineage?.decisionId?.trim()) {
    throw new Error(`Creative plan '${plan.id}' has no JEV decision lineage; refusing to store it.`);
  }
  const inserted = await sql<{ id: string }>`
    insert into creative_plans (
      id, organization_id, brand_id, brief_id, version, status, scope, autonomy, objective,
      plan_payload, budget_reserved_usd, spend_cap_usd, decision_id, created_at, updated_at
    ) values (
      ${plan.id}, ${input.organizationId}, ${input.brandId}, ${input.briefId},
      ${plan.version}, ${plan.status}, ${plan.scope}, ${plan.autonomy},
      ${plan.objective}, ${JSON.stringify(plan)},
      ${plan.estimatedCost.totalEstimatedUsd}, ${input.maxSpendUsd ?? null}, ${plan.lineage.decisionId}, now(), now()
    )
    on conflict (id) do nothing
    returning id
  `;
  if (inserted.length === 0) throw new Error(`Creative plan '${plan.id}' already exists; refusing to overwrite it.`);
}

type StoredJevDecision = {
  id: string;
  decision: string;
  reviewer_decision: string | null;
  evidence: string;
  answer: string;
  subject_type: string;
  schema_version: string;
  model_response: string;
  provider: string;
  model: string;
  question_id: string;
  question_version: string;
  reasons: string;
  probability: number;
  confidence: number;
};

/**
 * Loads the JEV decision a brief was produced under and applies the centralized gate.
 * Fails closed: a missing decision id, a row that is absent from this tenant and brand,
 * a BLOCK, and a REQUIRE_HUMAN outcome all throw. Callers run it before any write or billable call.
 */
export async function loadGatedJevDecision(
  sql: Sql,
  organizationId: string,
  brandId: string,
  decisionId: unknown,
  subject: "brief" | "plan" = "brief",
): Promise<StoredJevDecision> {
  const id = asText(decisionId).trim();
  if (!id) {
    throw new Error(`${subject === "plan" ? "CreativePlan" : "Brief"} has no JEV decision. Creative production is refused before any provider call.`);
  }
  const rows = await sql<StoredJevDecision>`
    select id, decision, reviewer_decision, evidence, answer, subject_type, schema_version,
           model_response, provider, model, question_id, question_version, reasons, probability, confidence
    from jev_decisions
    where id = ${id} and organization_id = ${organizationId} and brand_id = ${brandId}
    limit 1
  `;
  const dec = rows[0];
  if (!dec) {
    throw new Error(`The JEV decision for this ${subject} was not found in this brand. Creative production is refused before any provider call.`);
  }
  // Enforce Decision Semantics via centralized evaluateJevGate (P0-2)
  const gate = evaluateJevGate({ decision: dec.decision, reviewerDecision: dec.reviewer_decision });
  if (gate.status === "BLOCK") {
    throw new Error(`JEV policy rejected this brief: ${gate.reason}. Creative production is blocked.`);
  }
  if (gate.status === "REQUIRE_HUMAN") {
    throw new Error("JEV requires recorded human review for this brief before production can proceed.");
  }
  return dec;
}

export async function generateStudioVariants(
  userId: string,
  data: {
    brandId: string;
    briefId: string;
    imageProvider: string;
    videoProvider: string;
    mode?: import("../factory/creative-manifest.ts").CreationMode;
    creationScope?: CreationScope;
    autonomy?: AutonomyMode;
    maxSpendUsd?: number;
    source?: import("../factory/creative-manifest.ts").StartingMaterialType;
    productionMode?: import("../factory/creative-manifest.ts").ProductionStrategyType;
    aspectRatio?: "9:16" | "16:9" | "1:1" | "4:5";
  },
) {
  const context = { userId };
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");

    // Canonicalize video provider (P0-B)
    data.videoProvider = data.videoProvider === "omni" ? "google_omni" : data.videoProvider;
    data.imageProvider = data.imageProvider === "google:nano-banana" ? "google_nano_banana" : data.imageProvider;
    if (data.videoProvider === "auto") data.videoProvider = "google_omni";
    // The placeholder image provider is isolated to TestingRuntime. Refuse before any write.
    if (data.imageProvider === "test:image" && !isTestingRuntime()) {
      throw new Error("The test image provider is isolated to TestingRuntime. Choose a live image provider or no images.");
    }

    const briefs = await sql<Record<string, unknown>>`
      select * from briefs
      where id = ${data.briefId} and brand_id = ${data.brandId} and organization_id = ${access.organizationId}
      limit 1
    `;
    const brief = briefs[0];
    if (!brief || asText(brief.status) === "rejected") throw new Error("Brief not found.");
    const loaded = await loadBrandContext(sql, access.organizationId, data.brandId);
    assertSameTenant(loaded.creatives, access.organizationId, data.brandId);
    const productName = loaded.products[0]?.name || "";

    // Resolve creationScope and autonomy (P1.2)
    const creationScope: CreationScope = (data.creationScope && data.creationScope !== "auto_choose")
      ? data.creationScope
      : (
        data.imageProvider && data.imageProvider !== "none" && (!data.videoProvider || data.videoProvider === "none") ? "image_only" :
        data.videoProvider && data.videoProvider !== "none" && (!data.imageProvider || data.imageProvider === "none") ? "video_only" :
        data.mode === "image_ad" || data.mode === "organic_image" ? "image_only" :
        data.mode === "video" || data.mode === "video_reel_short" ? "video_only" :
        data.mode === "carousel" ? "carousel_only" :
        data.mode === "mixed_format" || data.mode === "mixed_campaign" ? "mixed_campaign" :
        data.mode === "research_only" ? "research_only" :
        "auto_choose"
      );
    const autonomy: AutonomyMode = data.autonomy || "semi_automatic";

    // Load the JEV decision this brief was produced under and gate it before any plan is written
    // or any provider is called. A null decision id or a missing row is refused, never skipped (M2).
    const dec = await loadGatedJevDecision(sql, access.organizationId, data.brandId, brief.decision_id);
    const jevBundle = creativeJudgmentsFromStoredDecision({
      id: dec.id,
      subjectType: dec.subject_type,
      questionId: dec.question_id,
      questionVersion: dec.question_version,
      schemaVersion: dec.schema_version,
      decision: dec.decision,
      reviewerDecision: dec.reviewer_decision,
      answer: dec.answer,
      modelResponse: dec.model_response,
      evidence: dec.evidence,
      provider: dec.provider,
      model: dec.model,
    });

    // Build CreativePlan via CreativeDecisionEngine (P0.5, P1.1, P0-A)
    const creativePlan = CreativeDecisionEngine.createPlan({
      // Lineage is the gated decision and the evidence it cited, not the brief's free-text fields (P3a).
      lineage: { decisionId: dec.id, evidenceRefs: jevBundle.evidenceRefs },
      // The brief, read once here, is copied into the plan. Production never reads it again (P3c).
      productionContext: {
        title: asText(brief.title),
        audience: asText(brief.audience),
        angle: asText(brief.angle),
        productName,
        opportunityId: asText(brief.opportunity_id) || null,
      },
      scope: creationScope,
      autonomy,
      preferredImageProvider: data.imageProvider,
      preferredVideoProvider: data.videoProvider,
      brief: {
        title: asText(brief.title),
        hook: asText(brief.hook),
        message: asText(brief.message),
        cta: asText(brief.cta),
        angle: asText(brief.angle),
        productName,
        aspectRatio: data.aspectRatio || "9:16",
        targetDurationSeconds: 8,
        decisionId: asText(brief.decision_id),
      },
      jevJudgments: jevBundle,
      constraints: {
        maxSpendUsd: data.maxSpendUsd,
      },
    });

    // Persist CreativePlan in durable creative_plans table (P0-D, P1-B)
    await persistCreativePlanRow(sql, {
      plan: creativePlan,
      organizationId: access.organizationId,
      brandId: data.brandId,
      briefId: data.briefId,
      maxSpendUsd: data.maxSpendUsd,
    });

    // Handle JEV Abstention: never fabricate an unverified AI recommendation (P0-A)
    if (creativePlan.status === "abstained") {
      return {
        status: "abstained",
        planId: creativePlan.id,
        plan: creativePlan,
        note: creativePlan.whyFormatChosen,
        requiresHumanChoice: true,
      };
    }

    // Handle JEV Reject (P0-2)
    if (creativePlan.status === "rejected") {
      return {
        status: "rejected",
        planId: creativePlan.id,
        plan: creativePlan,
        error: "JEV policy rejected this brief. Creative production is forbidden.",
      };
    }

    // Handle Manual or Semi-Automatic Approval Gate (P0-D)
    if (autonomy === "manual" || autonomy === "semi_automatic") {
      return {
        status: "awaiting_approval",
        planId: creativePlan.id,
        plan: creativePlan,
        requiresApproval: true,
        estimatedCostUsd: creativePlan.estimatedCost.totalEstimatedUsd,
        note: `Creative plan prepared in ${autonomy} mode. Approval required before billable generation.`,
      };
    }

    // Handle Fully-Automatic exceeding spend cap (P0-D)
    if (creativePlan.status === "awaiting_approval") {
      return {
        status: "awaiting_approval",
        planId: creativePlan.id,
        plan: creativePlan,
        requiresApproval: true,
        estimatedCostUsd: creativePlan.estimatedCost.totalEstimatedUsd,
        error: `Plan exceeds spend cap or policy limits. Approval required.`,
      };
    }

    await transitionCreativePlan(sql, {
      organizationId: access.organizationId,
      brandId: data.brandId,
      planId: creativePlan.id,
      actorId: context.userId,
      target: "executing",
    });

    return executeApprovedCreativePlan(sql, access, context.userId, creativePlan);
}

/**
 * Budget reservation shares for an approved plan, keyed by deliverable id. Fails closed.
 *
 * Priced deliverables reserve their known estimate, and those estimates must add up to the plan's known total (to within
 * one cent of rounding). An unpriced deliverable (no declared price, such as an image) has no estimate to reserve, so it
 * reserves an equal share of the plan's explicit spend cap, the most it can cost, and is settled at that ceiling because
 * its actual provider cost is not known. A plan with an unpriced deliverable and no cap is refused. A plan with no
 * priced and no unpriced cost reserves nothing only when every deliverable's model is registered as free of charge.
 */
function planReservationShares(plan: CreativePlan): Map<string, bigint> | null {
  const isFree = (d: CreativePlan["deliverables"][number]) => modelCapabilityRegistry.isEstablishedFree(d.provider, d.model);
  const allFree = plan.deliverables.every(isFree);
  const unpriced = new Set(plan.estimatedCost?.unpricedDeliverableIds ?? []);
  const total = plan.estimatedCost?.totalEstimatedUsd;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
    if (allFree) return null;
    throw new InvalidBudgetCapError(
      `Cost estimate is missing or invalid (${String(total)}) for a billable plan. Budget reservation refused; no provider was called.`
    );
  }
  if (total === 0 && unpriced.size === 0) {
    if (allFree) return null;
    throw new InvalidBudgetCapError(
      "Zero cost estimate for a billable provider. Budget reservation refused; no provider was called."
    );
  }
  const perDeliverable = plan.estimatedCost?.perDeliverableUsd ?? {};
  const shares = new Map<string, bigint>();
  let knownSum = 0n;
  for (const deliverable of plan.deliverables) {
    if (unpriced.has(deliverable.id)) continue;
    const raw = perDeliverable[deliverable.id];
    if (raw === undefined && isFree(deliverable)) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      throw new InvalidBudgetCapError(
        `Deliverable '${deliverable.id}' has no valid cost estimate. Budget reservation refused; no provider was called.`
      );
    }
    const micros = toMicros(raw);
    knownSum += micros;
    if (micros > 0n) shares.set(deliverable.id, micros);
  }
  const knownTotalMicros = toMicros(total);
  const drift = knownSum > knownTotalMicros ? knownSum - knownTotalMicros : knownTotalMicros - knownSum;
  if (drift > 10_000n) {
    throw new InvalidBudgetCapError(
      "Per-deliverable estimates do not add up to the plan estimate. Budget reservation refused; no provider was called."
    );
  }
  if (unpriced.size > 0) {
    const cap = plan.estimatedCost?.maxSpendUsd;
    if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) {
      throw new InvalidBudgetCapError(
        `Deliverables with no known price (${[...unpriced].join(", ")}) need an explicit plan spend cap. Budget reservation refused; no provider was called.`
      );
    }
    const remaining = toMicros(cap) - knownTotalMicros;
    const each = remaining / BigInt(unpriced.size);
    if (each <= 0n) {
      throw new InvalidBudgetCapError(
        "The plan spend cap leaves nothing for deliverables with no known price. Budget reservation refused; no provider was called."
      );
    }
    for (const deliverable of plan.deliverables) {
      if (unpriced.has(deliverable.id)) shares.set(deliverable.id, each);
    }
  }
  return shares;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Marks an image job whose provider outcome is unknown. Its reservation stays held for reconciliation, and it is never resubmitted. */
async function markImageJobUnknown(sql: Sql, jobId: string, organizationId: string, brandId: string, code: string, message: string) {
  await sql`
    update production_jobs set status = 'SUBMISSION_UNKNOWN', error_code = ${code}, error_message = ${message}, updated_at = now()
    where id = ${jobId} and organization_id = ${organizationId} and brand_id = ${brandId}
  `;
}

/** Inserts the durable row for one image job. The first snapshot for an id stands: a conflicting insert is ignored. */
async function insertImageJobRow(sql: Sql, row: {
  id: string;
  organizationId: string;
  brandId: string;
  providerId: string;
  status: "SUBMITTING" | "FAILED";
  creativePlanId: string;
  sequenceIndex: number;
  /** The carousel this slide belongs to, or null for a single image. */
  parentJobId: string | null;
  costStatus: string | null;
  /** Null when the cost is unknown. A zero here would be an invented price. */
  estimateCents: number | null;
  input: string;
  errorCode?: string;
  errorMessage?: string;
}) {
  await sql`
    insert into production_jobs (
      id, organization_id, brand_id, provider, provider_job_id, request_id, status_url, cancel_url,
      status, cost_mode, estimated_cost_cents, input, created_at, submitted_at, updated_at, creative_plan_id,
      modality, sequence_index, parent_job_id, cost_status, error_code, error_message
    ) values (
      ${row.id}, ${row.organizationId}, ${row.brandId}, ${row.providerId}, null, null, null, null,
      ${row.status}, 'BALANCED', ${row.estimateCents}, ${row.input}, now(), null, now(), ${row.creativePlanId},
      'image', ${row.sequenceIndex}, ${row.parentJobId}, ${row.costStatus}, ${row.errorCode ?? null}, ${row.errorMessage ?? null}
    )
    on conflict (id) do nothing
  `;
}

/** Releases every reservation that no provider submission can be holding. Held ones stay for reconciliation. */
async function releaseUnheldReservations(
  sql: Sql,
  reservations: Map<string, { id: string; held: boolean }>,
  reason: string,
) {
  for (const reservation of reservations.values()) {
    if (reservation.held) continue;
    await BudgetLedgerService.release(sql, { reservationId: reservation.id, reason }).catch(() => {});
  }
}

export async function executeApprovedCreativePlan(
  sql: Sql,
  access: { organizationId: string; role: Role },
  userId: string,
  creativePlan: CreativePlan,
) {
  // P3c: production runs on the plan row and its snapshot. The brief row is never read here, so an edit to it cannot
  // change what the plan produces. The brief id is kept only as a reference, and its status is updated by id.
  const persistedPlan = await sql<{ status: string; brand_id: string; decision_id: string | null; brief_id: string | null }>`
    select status, brand_id, decision_id, brief_id from creative_plans
    where id = ${creativePlan.id} and organization_id = ${access.organizationId}
    limit 1
  `;
  const planRow = persistedPlan[0];
  if (planRow?.status !== "executing") {
    throw new Error("CreativePlan must be durably approved and executing before provider calls.");
  }
  const brandId = planRow.brand_id;
  const briefId = planRow.brief_id ?? "";
  const decisionId = planRow.decision_id ?? "";
  const context = creativePlan.productionContext;
  // M2 and P3c: the gate runs on the decision the plan recorded, before any reservation or provider call. A refusal
  // closes the plan as failed.
  try {
    if (!context) throw new Error("CreativePlan has no production context; refusing to execute it. Re-plan from the brief.");
    await loadGatedJevDecision(sql, access.organizationId, brandId, decisionId, "plan");
  } catch (gateErr) {
    await transitionCreativePlan(sql, {
      organizationId: access.organizationId,
      brandId,
      planId: creativePlan.id,
      actorId: userId,
      target: "failed",
      reason: "JEV gate refused production before provider submission.",
    }).catch(() => {});
    throw gateErr;
  }

  const loaded = await loadBrandContext(sql, access.organizationId, brandId);
  assertSameTenant(loaded.creatives, access.organizationId, brandId);
  const productName = context.productName;

  // Derive concrete creation mode and beats from creativePlan.deliverables
  const hasVideo = creativePlan.deliverables.some((d) => d.kind === "video");
  const hasCarousel = creativePlan.deliverables.some((d) => d.kind === "carousel_slide");
  const hasImage = creativePlan.deliverables.some((d) => d.kind === "image");

  let mode: import("../factory/creative-manifest.ts").CreationMode;
  if (creativePlan.deliverables.length === 0 || creativePlan.scope === "research_only") {
    mode = "research_only";
  } else if ((hasVideo && (hasImage || hasCarousel)) || (hasCarousel && hasImage)) {
    mode = "mixed_format";
  } else if (hasVideo) {
    mode = "video";
  } else if (hasCarousel) {
    mode = "carousel";
  } else {
    mode = "image_ad";
  }

  const { validateCreationPlan, buildCreativeManifest, manifestFromCreativePlan } = await import("../factory/creative-manifest.ts");

  const deliverableManifests = creativePlan.deliverables.map((d) =>
    manifestFromCreativePlan(creativePlan, d, {
      organizationId: access.organizationId,
      brandId,
      productName,
      audience: context.audience,
    })
  );

  let beats: import("../factory/creative-manifest.ts").CreativeManifestBeat[] = [];
  let targetDurationSeconds: number | undefined;
  const slideCount = creativePlan.deliverables.filter((d) => d.kind === "carousel_slide").length || undefined;

  if (mode === "research_only") {
    targetDurationSeconds = undefined;
    beats = [];
  } else if (deliverableManifests.length > 0) {
    beats = deliverableManifests.flatMap((m) => m.beats);
    targetDurationSeconds = creativePlan.deliverables.find((d) => d.targetDurationSeconds)?.targetDurationSeconds || (hasVideo ? 8 : undefined);
  } else {
    targetDurationSeconds = undefined;
    beats = [];
  }

  const plan = validateCreationPlan({
    mode,
    startingMaterial: "new_brief",
    productionStrategy: "automated_provider",
    slideCount,
    beats,
  });

  if (!plan.valid) {
    throw new Error(`Creative plan invalid: ${plan.reason}`);
  }

  const rawRatio = creativePlan.deliverables[0]?.aspectRatio || "9:16";
  const aspectRatio: "9:16" | "16:9" | "1:1" | "4:5" = (rawRatio === "16:9" || rawRatio === "1:1" || rawRatio === "4:5") ? rawRatio : "9:16";
  const manifest = buildCreativeManifest({
    creativeId: crypto.randomUUID(),
    conceptId: context.opportunityId || creativePlan.id,
    mode,
    startingMaterial: "new_brief",
    productionStrategy: "automated_provider",
    brand: {
      organizationId: access.organizationId,
      brandId,
      product: productName,
      audience: context.audience,
      objective: context.angle,
    },
    format: {
      channel: "multi_channel",
      aspectRatio,
      targetDurationSeconds,
      slideCount,
    },
    beats,
  });

  if (!plan.willCreateProductionJob || mode === "research_only" || creativePlan.scope === "research_only" || creativePlan.deliverables.length === 0) {
    await sql`
      insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
      values (
        ${crypto.randomUUID()}, ${access.organizationId}, ${brandId}, ${userId},
        'studio.research_manifest_created', 'brief', ${briefId},
        ${JSON.stringify({ manifestId: manifest.creativeId, mode: manifest.mode, beats: manifest.beats.length, planId: creativePlan.id })}
      )
    `;
    await sql`update briefs set status = 'used' where id = ${briefId}`;
    await transitionCreativePlan(sql, {
      organizationId: access.organizationId, brandId, planId: creativePlan.id, actorId: userId,
      target: "executing", reason: "Approved research manifest is being finalized.",
    });
    await transitionCreativePlan(sql, {
      organizationId: access.organizationId, brandId, planId: creativePlan.id, actorId: userId,
      target: "completed", reason: "Research-only manifest completed without production jobs.",
    });
    return loadSession(sql, access.organizationId, brandId, access.role);
  }

  const usage = await sql<{ runs_today: number; running: number; brand_runs_today: number; brand_running: number }>`
    select
      count(*) filter (where created_at > now() - interval '1 day' and status in ('running', 'completed'))::int as runs_today,
      count(*) filter (where status = 'running')::int as running,
      count(*) filter (where brand_id = ${brandId} and created_at > now() - interval '1 day' and status in ('running', 'completed'))::int as brand_runs_today,
      count(*) filter (where brand_id = ${brandId} and status = 'running')::int as brand_running
    from generation_runs
    where organization_id = ${access.organizationId}
  `;
  const orgGate = generationAllowed({
    runsToday: asNumber(usage[0]?.runs_today),
    running: asNumber(usage[0]?.running),
  });
  const brandGate = generationAllowed({
    runsToday: asNumber(usage[0]?.brand_runs_today),
    running: asNumber(usage[0]?.brand_running),
  });
  const blocked = !orgGate.allowed ? orgGate : !brandGate.allowed ? brandGate : null;
  if (blocked) {
    await sql`
      insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
      values (
        ${crypto.randomUUID()}, ${access.organizationId}, ${brandId}, ${userId},
        'generation.blocked', 'brand', ${brandId},
        ${JSON.stringify({ reason: blocked.reason, estimatedCostCents: blocked.estimatedCostCents })}
      )
    `;
    throw new Error(blocked.reason);
  }

  // One reservation per deliverable that carries spend. Each video reservation is linked to its
  // production job id before any provider call, so its budget line is settled or held per job.
  const reservations = new Map<string, { id: string; amountMicros: bigint; held: boolean }>();
  const productionJobIds = new Map<string, string>();
  for (const deliverable of creativePlan.deliverables) {
    if (deliverable.kind === "video" || deliverable.kind === "image" || deliverable.kind === "carousel_slide") {
      productionJobIds.set(deliverable.id, crypto.randomUUID());
    }
  }
  let providerSubmissionUnknown = false;
  try {
    const shares = planReservationShares(creativePlan);
    for (const [deliverableId, amountMicros] of shares ?? []) {
      const reservation = await BudgetLedgerService.reserve(sql, {
        organizationId: access.organizationId,
        brandId,
        amountMicros,
        creativePlanId: creativePlan.id,
        productionJobId: productionJobIds.get(deliverableId),
      });
      reservations.set(deliverableId, { id: reservation.id, amountMicros, held: false });
    }
  } catch (budgetErr) {
    await releaseUnheldReservations(sql, reservations, "Budget reservation failed before provider submission.");
    await transitionCreativePlan(sql, {
      organizationId: access.organizationId,
      brandId,
      planId: creativePlan.id,
      actorId: userId,
      target: "failed",
      reason: "Budget reservation failed before provider submission.",
    }).catch(() => {});
    throw budgetErr;
  }

  const runId = crypto.randomUUID();
  // A carousel is one parent job whose slides are its children. The parent holds no reservation: each slide reserves its own.
  const carouselJobId = creativePlan.deliverables.some((d) => d.kind === "carousel_slide") ? `carousel-job-${creativePlan.id}` : null;
  const firstImgDeliv = creativePlan.deliverables.find((d) => d.kind === "image" || d.kind === "carousel_slide");
  const firstVidDeliv = creativePlan.deliverables.find((d) => d.kind === "video");
  const effectiveImageProvider = firstImgDeliv?.provider || "none";
  const effectiveVideoProvider = firstVidDeliv?.provider || "none";

  await sql`
    insert into generation_runs (
      id, organization_id, brand_id, opportunity_id, brief_id, prompt_version, image_provider, video_provider, status, created_by
    ) values (
      ${runId}, ${access.organizationId}, ${brandId}, ${context.opportunityId}, ${briefId},
      ${STUDIO_PROMPT_VERSION}, ${effectiveImageProvider}, ${effectiveVideoProvider}, 'running', ${userId}
    )
  `;

  try {

    if (carouselJobId) {
      const slideCount = creativePlan.deliverables.filter((d) => d.kind === "carousel_slide").length;
      await sql`
        insert into production_jobs (
          id, organization_id, brand_id, provider, provider_job_id, request_id, status_url, cancel_url,
          status, cost_mode, estimated_cost_cents, input, created_at, submitted_at, updated_at, creative_plan_id,
          modality, sequence_index, parent_job_id, cost_status
        ) values (
          ${carouselJobId}, ${access.organizationId}, ${brandId}, 'carousel', null, null, null, null,
          'AWAITING_CHILDREN', 'BALANCED', null, ${JSON.stringify({ kind: "carousel", slideCount, runId, briefId, planDeliverableIds: creativePlan.deliverables.filter((d) => d.kind === "carousel_slide").map((d) => d.id) })},
          now(), null, now(), ${creativePlan.id}, 'carousel', null, null, null
        )
        on conflict (id) do nothing
      `;
    }

    for (const deliv of creativePlan.deliverables) {
      if (deliv.kind === "image" || deliv.kind === "carousel_slide") {
        // Every image is a durable production job with the same lifecycle as video. Its job row and its budget reservation
        // exist before the provider is called, and its bytes are stored and verified before anything is materialized.
        const index = deliv.sequenceIndex ?? 0;
        const delivManifest = deliverableManifests.find((m) => m.deliverableId === deliv.id);
        if (!delivManifest) throw new Error(`CreativePlan deliverable ${deliv.id} has no executable manifest.`);
        const prodJobId = productionJobIds.get(deliv.id);
        if (!prodJobId) throw new Error(`CreativePlan deliverable ${deliv.id} has no production job id.`);
        const promptVersion = `${STUDIO_PROMPT_VERSION}#${deliv.kind}-${index + 1}`;
        const prompt = variantPrompt({
          productName,
          angle: delivManifest.concept?.mechanism || "",
          hook: delivManifest.hook?.text || "",
          audience: delivManifest.brand.audience,
          constraints: creativePlan.constraintsApplied.map((constraint) => `${constraint.constraintName}: ${String(constraint.constraintValue)}`).join("; "),
          index,
          kind: "image",
        });
        const copy = `${productName}. ${prompt}`;
        const itemLabel = deliv.kind === "carousel_slide" ? `carousel slide ${index + 1}` : `image ${index + 1}`;
        const imageTarget = resolveProductionTarget({
          provider: delivManifest.production!.provider,
          model: delivManifest.production!.model,
          capability: "IMAGE_GENERATION",
          aspectRatio: delivManifest.format.aspectRatio,
        });
        const reservation = reservations.get(deliv.id);
        // An unpriced image is allowed only because its reservation is bounded by the plan's spend cap (planReservationShares).
        const unpriced = creativePlan.estimatedCost?.unpricedDeliverableIds?.includes(deliv.id) === true;
        const spec: CreativeSpec = {
          id: deliv.id,
          organizationId: access.organizationId,
          brandId,
          title: context.title,
          modality: "image",
          format: deliv.format,
          aspectRatio: delivManifest.format.aspectRatio as CreativeSpec["aspectRatio"],
          // An image has no duration. The matrix reads no duration for an image.
          durationTargetSeconds: 0,
          hookLine: delivManifest.hook?.text || "",
          script: copy,
          scenes: [],
          assetIds: [],
          idempotencyKey: prodJobId,
        };

        let selected: ImageProviderSelection;
        try {
          selected = await productionRouter.selectImageForSpec(spec, { requestedProvider: imageTarget.provider, allowUnknownCost: unpriced });
        } catch (refusal) {
          // Refused before any provider call. The refusal is recorded on the job, and its reservation is released.
          await insertImageJobRow(sql, {
            id: prodJobId, organizationId: access.organizationId, brandId, providerId: imageTarget.provider, status: "FAILED",
            creativePlanId: creativePlan.id, sequenceIndex: index, parentJobId: deliv.kind === "carousel_slide" ? carouselJobId : null, costStatus: null, estimateCents: null,
            input: JSON.stringify({ kind: "image", creativeSpec: spec, runId, briefId, planDeliverableId: deliv.id }),
            errorCode: "SELECTION_REFUSED", errorMessage: errorText(refusal),
          });
          if (reservation && !reservation.held) {
            await BudgetLedgerService.release(sql, { reservationId: reservation.id, reason: "Image was refused before any provider call." }).catch(() => {});
          }
          // An approved provider that cannot produce this deliverable stops the run, as an approved video provider does.
          throw refusal;
        }
        const chosen = selected.selection.chosen!;
        spec.providerId = selected.provider.id;
        spec.modelId = chosen.modelId;
        // The job's snapshot is written once, before the provider call. Materialization reads only this snapshot.
        await insertImageJobRow(sql, {
          id: prodJobId, organizationId: access.organizationId, brandId, providerId: selected.provider.id, status: "SUBMITTING",
          creativePlanId: creativePlan.id, sequenceIndex: index, parentJobId: deliv.kind === "carousel_slide" ? carouselJobId : null, costStatus: chosen.costStatus,
          estimateCents: chosen.estimateUsd === null ? null : Math.round(chosen.estimateUsd * 100),
          input: JSON.stringify({
            kind: "image", creativeSpec: spec, runId, briefId, manifest: delivManifest, planDeliverableId: deliv.id,
            deliverableKind: deliv.kind, sequenceIndex: index, itemLabel, format: deliv.format, prompt, copy, productName,
            promptVersion, providerSelection: selected.selection, qcBrand: qcBrandOf(loaded),
          }),
        });

        // The reservation is held before the call. From here a failure is ambiguous, so the reservation is never released.
        if (reservation) reservation.held = true;
        let outcome: ImageGenerationOutcome;
        try {
          outcome = await selected.provider.generate({
            prompt,
            seed: `${runId}:${deliv.kind}:${index}`,
            promptVersion,
            model: chosen.modelId,
            aspectRatio: spec.aspectRatio,
          });
        } catch (callError) {
          providerSubmissionUnknown = true;
          await markImageJobUnknown(sql, prodJobId, access.organizationId, brandId, "PROVIDER_CALL_AMBIGUOUS", errorText(callError));
          throw callError;
        }
        if (outcome.status === "NOT_CONNECTED") {
          // No credentials, so the provider was never called: nothing was submitted and the reservation is released.
          await sql`
            update production_jobs set status = 'FAILED', error_code = 'NOT_CONNECTED', error_message = ${outcome.error}, updated_at = now()
            where id = ${prodJobId} and organization_id = ${access.organizationId} and brand_id = ${brandId}
          `;
          if (reservation) {
            reservation.held = false;
            await BudgetLedgerService.release(sql, { reservationId: reservation.id, reason: outcome.error }).catch(() => {});
          }
          continue;
        }
        if (outcome.status === "failed") {
          // The call returned a failure after it may have reached the provider, so no charge can be ruled out. The
          // reservation stays held for reconciliation, and the plan is not completed on this run.
          providerSubmissionUnknown = true;
          await markImageJobUnknown(sql, prodJobId, access.organizationId, brandId, "PROVIDER_CALL_FAILED", outcome.error);
          throw new Error(`Image provider '${outcome.provider}' failed; its reservation is held for reconciliation. ${outcome.error}`);
        }

        const finalized = await finalizeProductionArtifact(sql, {
          jobId: prodJobId,
          organizationId: access.organizationId,
          brandId,
          provider: outcome.provider,
          rawArtifact: { bytes: outcome.bytes, mimeType: outcome.mediaType },
        });
        if (!finalized.success) {
          // The image was generated, so the spend happened. The reservation settles at its reserved amount, and the job
          // records why its artifact was not stored.
          await sql`
            update production_jobs set status = 'FAILED', error_code = ${finalized.errorCode ?? "STORAGE_PERSISTENCE_FAILED"},
              error_message = ${finalized.error ?? "The artifact could not be stored."}, updated_at = now()
            where id = ${prodJobId} and organization_id = ${access.organizationId} and brand_id = ${brandId}
          `;
          await settleProductionReservation(sql, { organizationId: access.organizationId, brandId, productionJobId: prodJobId });
          continue;
        }
        await sql`
          update production_jobs set output = ${JSON.stringify({
            width: outcome.width, height: outcome.height, mediaType: outcome.mediaType,
            promptVersion: outcome.promptVersion, model: outcome.model, provider: outcome.provider,
          })}, updated_at = now()
          where id = ${prodJobId} and organization_id = ${access.organizationId} and brand_id = ${brandId}
        `;
        try {
          await completeProductionJob(sql, { organizationId: access.organizationId, brandId, productionJobId: prodJobId }, { openReview: true });
        } catch (materializeError) {
          // The artifact is verified and the job is COMPLETED, so nothing is lost. The poller finishes it from this state.
          await sql`
            update production_jobs set error_message = ${errorText(materializeError)}, next_poll_at = now() + interval '30 seconds', updated_at = now()
            where id = ${prodJobId} and organization_id = ${access.organizationId} and brand_id = ${brandId}
          `;
        }
      } else if (deliv.kind === "video") {
        const decisionRows = await sql<{
          id: string;
          organization_id: string;
          brand_id: string;
          question_id: string;
          policy_version: string;
          decision: string;
          reviewer_decision: string | null;
          reasons: string;
          evidence: string;
        }>`
          select id, organization_id, brand_id, question_id, policy_version, decision, reviewer_decision, reasons, evidence
          from jev_decisions
          where id = ${decisionId} and organization_id = ${access.organizationId} and brand_id = ${brandId}
          limit 1
        `;
        const decisionRow = decisionRows[0];
        if (!decisionRow) throw new Error("JEV has not approved this creative. No video job was created.");
        const gate = evaluateJevGate({
          decision: decisionRow.decision,
          reviewerDecision: decisionRow.reviewer_decision,
        });
        if (gate.status === "BLOCK") {
          throw new Error(`Brief is rejected by Brand Guardian policy (${gate.reason}). Creative generation blocked.`);
        }
        if (gate.status === "REQUIRE_HUMAN") {
          throw new Error("Brief requires human review approval before video generation.");
        }

        const delivManifest = deliverableManifests.find((m) => m.deliverableId === deliv.id);
        if (!delivManifest) throw new Error(`CreativePlan deliverable ${deliv.id} has no executable manifest.`);
        const creativeSpec = creativeSpecFromManifest(delivManifest, {
          organizationId: access.organizationId,
          brandId,
          title: context.title,
        });

        const targetVidProvider = delivManifest.production!.provider;
        const productionTarget = resolveProductionTarget({
          provider: targetVidProvider,
          model: creativeSpec.modelId!,
          capability: "VIDEO_GENERATION",
          aspectRatio: creativeSpec.aspectRatio,
          durationSeconds: creativeSpec.durationTargetSeconds,
        });
        creativeSpec.providerId = productionTarget.provider;
        creativeSpec.modelId = productionTarget.model;
        // P4a: the provider and model are chosen by the capability matrix, and the choice is recorded on the job.
        const { provider, selection } = await productionRouter.selectForSpec(
          creativeSpec,
          "BALANCED",
          targetVidProvider === "auto" ? undefined : targetVidProvider,
        );
        creativeSpec.providerId = provider.id;
        creativeSpec.modelId = selection.chosen?.modelId ?? creativeSpec.modelId;
        // The job's estimate is stored in cents with a default of zero, so an unknown cost cannot be recorded without
        // inventing a zero. Refuse it before any job row or provider call exists.
        if (!selection.chosen?.costKnown || selection.chosen.estimateUsd === null) {
          throw new Error(`Video cost is not known for provider '${provider.id}'. No job was created.`);
        }
        const prodJobId = productionJobIds.get(deliv.id) ?? crypto.randomUUID();
        creativeSpec.idempotencyKey = prodJobId;
        const durableInput = JSON.stringify({
          creativeSpec, runId, briefId: briefId, manifestId: delivManifest.creativeId,
          manifest: delivManifest, planDeliverableId: deliv.id, providerSelection: selection,
        });
        await sql`
          insert into production_jobs (
            id, organization_id, brand_id, provider, provider_job_id, request_id, status_url, cancel_url,
            status, cost_mode, estimated_cost_cents, input, created_at, submitted_at, updated_at, creative_plan_id
          ) values (
            ${prodJobId}, ${access.organizationId}, ${brandId}, ${provider.id}, null, null, null, null,
            'SUBMITTING', 'BALANCED', ${Math.round(selection.chosen.estimateUsd * 100)},
            ${durableInput}, now(), null, now(), ${creativePlan.id}
          )
          on conflict (id) do nothing
        `;
        let submittedJob: import("../production/types.ts").ProductionJob;
        const videoReservation = reservations.get(deliv.id);
        if (videoReservation) videoReservation.held = true;
        try {
          submittedJob = await provider.submitJob(creativeSpec);
        } catch (submitError) {
          providerSubmissionUnknown = true;
          await sql`
            update production_jobs
            set status = 'SUBMISSION_UNKNOWN', error_code = 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
              error_message = ${submitError instanceof Error ? submitError.message : String(submitError)}, updated_at = now()
            where id = ${prodJobId} and organization_id = ${access.organizationId} and brand_id = ${brandId}
          `;
          throw new Error("Provider submission outcome is unknown. The durable job and budget reservation are held for reconciliation; it was not resubmitted.");
        }
        if (submittedJob.status === "SUBMISSION_UNKNOWN") {
          providerSubmissionUnknown = true;
          await sql`
            update production_jobs
            set status = 'SUBMISSION_UNKNOWN', error_code = 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
              error_message = ${submittedJob.error || "Provider submission outcome is unknown; automatic retry is disabled."},
              updated_at = now()
            where id = ${prodJobId} and organization_id = ${access.organizationId} and brand_id = ${brandId}
          `;
          throw new Error("Provider submission outcome is unknown. The durable job and budget reservation are held for reconciliation; it was not resubmitted.");
        }
        if (submittedJob.status === "FAILED" || submittedJob.status === "PREFLIGHT_FAILED" || submittedJob.status === "NOT_CONFIGURED") {
          // Definitive provider rejection: nothing was accepted, so the reservation may be released.
          if (videoReservation) videoReservation.held = false;
          await sql`
            update production_jobs set status = 'FAILED', error_code = ${submittedJob.errorCode || submittedJob.status},
              error_message = ${submittedJob.error || "Provider rejected the request."}, updated_at = now()
            where id = ${prodJobId} and organization_id = ${access.organizationId} and brand_id = ${brandId}
          `;
          throw new Error(`Video production failed (${submittedJob.status}): ${submittedJob.error || "Provider rejected job."}`);
        }

        await sql`
          update production_jobs set status = ${submittedJob.status},
            provider_job_id = ${submittedJob.providerJobId || submittedJob.jobId || null},
            request_id = ${submittedJob.requestId || null}, status_url = ${submittedJob.statusUrl || null},
            cancel_url = ${submittedJob.cancelUrl || null}, submitted_at = now(), error_code = null,
            error_message = null, updated_at = now()
          where id = ${prodJobId} and organization_id = ${access.organizationId} and brand_id = ${brandId}
        `;

        let finalResult: import("../production/artifact-finalizer.ts").ArtifactFinalizeResult | null = null;
        if (submittedJob.status === "COMPLETED" || submittedJob.status === "RENDERED") {
          finalResult = await finalizeProductionArtifact(sql, {
            jobId: prodJobId,
            organizationId: access.organizationId,
            brandId,
            provider: provider.id,
            providerJobId: submittedJob.providerJobId || submittedJob.jobId,
            runId,
            rawArtifact: {
              uri: submittedJob.outputArtifactId,
              base64: (submittedJob.metadata?.videoBytesBase64 as string) || undefined,
              mimeType: (submittedJob.metadata?.mimeType as string) || undefined,
            },
            options: {
              durationMs: (creativeSpec.durationTargetSeconds ?? 8) * 1000,
              job: submittedJob,
            },
          });
        }

        if (finalResult && !finalResult.success) {
          await sql`
            update production_jobs
            set status = ${finalResult.status}, error_message = ${finalResult.error || "Storage persistence failed"}, updated_at = now()
            where id = ${prodJobId}
          `;
        } else if (finalResult?.success) {
          // Shared with the poller: creates the creative, asset, and settles this job's reservation.
          await completeProductionJob(sql, { organizationId: access.organizationId, brandId, productionJobId: prodJobId }, { openReview: false });
        }
      }
    }

    if (carouselJobId) {
      await settleCarouselParent(sql, { organizationId: access.organizationId, brandId, productionJobId: carouselJobId });
    }

    const videos = await sql<Record<string, unknown>>`
      select a.id, a.creative_id, a.storage_key, a.media_status, a.byte_size, a.width, a.height, a.duration_ms, a.transcript,
             a.scenes, a.checksum, a.mime_type, a.prompt_version, c.raw_text, c.angle
      from assets a
      join creative_records c on c.id = a.creative_id
      where a.generation_run_id = ${runId} and a.kind = 'video' and a.organization_id = ${access.organizationId}
    `;
    for (const video of videos) {
      const scenes = asJson<{ summary: string }[]>(video.scenes, []);
      const copy = asText(video.raw_text);
      const ownSemantic = await semanticNearest(copy, loaded.creatives.filter((item) => item.origin !== "competitor").map((item) => item.text)).catch(() => null);
      const publishing = assessPublishing({
        accounts: await accountSnapshots(sql, access.organizationId),
        provider: "test:publisher",
        kind: "video",
        mime: asText(video.mime_type),
        width: video.width == null ? null : asNumber(video.width),
        height: video.height == null ? null : asNumber(video.height),
        byteSize: asNumber(video.byte_size),
        destinationUrl: "",
      });
      const visual = await measuredVideoFrames(sql, access.organizationId, brandId, asText(video.storage_key));
      const selection = await resolveActiveEngine(sql, access.organizationId);
      // Perception is used only when the engine cannot see frames. It is checked here, before any frame is sampled for it.
      const perceptionCandidate = selectPerceptionProvider().provider;
      const perceptionForJudgment = selection.engineId !== "openai-decisions" && perceptionCandidate &&
        (await perceptionCandidate.health()).state === "HEALTHY" ? perceptionCandidate : null;
      const facts = factsFor(loaded, {
        kind: "video",
        productName,
        angle: asText(video.angle),
        copy,
        prompt: copy,
        mime: asText(video.mime_type),
        byteSize: asNumber(video.byte_size),
        width: video.width == null ? null : asNumber(video.width),
        height: video.height == null ? null : asNumber(video.height),
        checksum: asText(video.checksum),
        durationMs: video.duration_ms == null ? null : asNumber(video.duration_ms),
        transcript: asText(video.transcript),
        sceneCount: scenes.length,
        logoSimilarity: visual.measuredLogo.similarity,
        logoOutcome: visual.measuredLogo.outcome,
        logoEvidence: visual.measuredLogo.evidence,
        paletteDistance: visual.measuredPalette.distance,
        paletteOutcome: visual.measuredPalette.outcome,
        paletteEvidence: visual.measuredPalette.evidence,
        semanticSimilarity: await semanticNearest(copy, competitorCopy(loaded)).catch(() => null),
        ownSemanticSimilarity: ownSemantic,
        publishing,
      });
      const judged = await writeJudgment(sql, {
        organizationId: access.organizationId,
        brandId,
        creativeId: asText(video.creative_id),
        facts,
        selection,
        perception: perceptionForJudgment,
        visual: await videoVisualEvidence(sql, access.organizationId, brandId, asText(video.storage_key), video.duration_ms == null ? null : asNumber(video.duration_ms), {
          sample: selection.engineId === "openai-decisions" || perceptionForJudgment !== null,
        }),
      });
      const status = judged.rollup === "REJECT" ? "rejected" : "in_review";
      await sql`update creative_records set status = ${status}, updated_at = now() where id = ${asText(video.creative_id)}`;
      await sql`
        update assets set qa_decision = ${judged.rollup}, review_status = ${status}, lifecycle = 'qa_required'
        where id = ${asText(video.id)}
      `;
      if (status === "in_review") {
        await openProductionReview(sql, {
          organizationId: access.organizationId,
          brandId,
          creativeId: asText(video.creative_id),
          decisionId: decisionId,
          subjectLabel: "Video",
        });
      }
    }

    // Image spend settles now. Video spend settles per job when its artifact is materialized.
    for (const [deliverableId, reservation] of reservations) {
      if (productionJobIds.has(deliverableId)) continue;
      await BudgetLedgerService.reconcile(sql, {
        reservationId: reservation.id,
        cost: { basis: "ESTIMATED", amountMicros: reservation.amountMicros, estimatorVersion: ESTIMATOR_VERSION },
      });
    }

    await sql`update briefs set status = 'used' where id = ${briefId}`;
    await sql`update generation_runs set status = 'completed' where id = ${runId}`;
    await settleCreativePlanIfComplete(sql, {
      organizationId: access.organizationId,
      brandId,
      planId: creativePlan.id,
      actorId: userId,
    });
    return loadSession(sql, access.organizationId, brandId, access.role);
  } catch (error) {
    if (carouselJobId) {
      await settleCarouselParent(sql, { organizationId: access.organizationId, brandId, productionJobId: carouselJobId }, { interrupted: true })
        .catch(() => undefined);
    }
    await releaseUnheldReservations(sql, reservations, error instanceof Error ? error.message : String(error));
    await sql`
      update generation_runs set status = 'failed'
      where id = ${runId} and organization_id = ${access.organizationId} and status = 'running'
    `;
    const acceptedJobInFlight = !providerSubmissionUnknown && [...reservations.values()].some((r) => r.held);
    if (!acceptedJobInFlight) {
      await transitionCreativePlan(sql, {
        organizationId: access.organizationId, brandId, planId: creativePlan.id, actorId: userId,
        target: "failed", reason: error instanceof Error ? error.message : String(error),
      }).catch(() => {});
    }
    throw error;
  }
}

export async function approveAndExecuteCreativePlan(
  userId: string,
  data: { brandId: string; planId: string },
) {
  const sql = await getSql();
  const access = await requireBrand(sql, userId, data.brandId, "member");

  const existingPlans = await sql<{
    id: string;
    organization_id: string;
    brand_id: string;
    brief_id: string;
    version: string;
    status: string;
    scope: string;
    autonomy: string;
    objective: string;
    plan_payload: string;
    budget_reserved_usd: number;
    spend_cap_usd: number | null;
  }>`
    select * from creative_plans
    where id = ${data.planId} and brand_id = ${data.brandId} and organization_id = ${access.organizationId}
    limit 1
  `;

  const planRow = existingPlans[0];
  if (!planRow) {
    const existing = await sql<{ id: string; status: string }>`
      select id, status from creative_plans
      where id = ${data.planId} and brand_id = ${data.brandId} and organization_id = ${access.organizationId}
      limit 1
    `;
    if (!existing[0]) {
      throw new Error("Creative plan not found.");
    }
    if (existing[0].status === "executing") {
      throw new Error("Creative plan is currently executing.");
    }
    if (existing[0].status === "completed") {
      return loadSession(sql, access.organizationId, data.brandId, access.role);
    }
    if (existing[0].status === "abstained") {
      throw new Error("Cannot execute an abstained plan without choosing a format.");
    }
    if (existing[0].status === "rejected") {
      throw new Error("Cannot execute a rejected plan.");
    }
    if (existing[0].status === "failed") {
      throw new Error("Cannot execute a failed plan.");
    }
    if (existing[0].status === "draft") {
      throw new Error("Cannot execute a draft plan without preparation.");
    }
    throw new Error(`Creative plan is not awaiting approval (status: ${existing[0].status}).`);
  }

  // Load the brief
  const briefs = await sql<Record<string, unknown>>`
    select * from briefs
    where id = ${planRow.brief_id} and brand_id = ${data.brandId} and organization_id = ${access.organizationId}
    limit 1
  `;
  const brief = briefs[0];
  if (!brief) throw new Error("Brief associated with creative plan not found.");

  const planPayload: CreativePlan = typeof planRow.plan_payload === "string"
    ? JSON.parse(planRow.plan_payload)
    : planRow.plan_payload;

  await transitionCreativePlan(sql, {
    organizationId: access.organizationId,
    brandId: data.brandId,
    planId: data.planId,
    actorId: userId,
    target: "approved",
  });
  await transitionCreativePlan(sql, {
    organizationId: access.organizationId,
    brandId: data.brandId,
    planId: data.planId,
    actorId: userId,
    target: "executing",
  });
  return executeApprovedCreativePlan(sql, access, userId, planPayload);
}

export async function rejectCreativePlan(
  userId: string,
  data: { brandId: string; planId: string; reason?: string },
) {
  const sql = await getSql();
  const access = await requireBrand(sql, userId, data.brandId, "member");

  await transitionCreativePlan(sql, {
    organizationId: access.organizationId,
    brandId: data.brandId,
    planId: data.planId,
    actorId: userId,
    target: "rejected",
    reason: data.reason,
  });
  return loadSession(sql, access.organizationId, data.brandId, access.role);
}

export async function reviewStudioVariant(
  userId: string,
  data: { brandId: string; creativeId: string; action: string; reasonCode: string; note: string },
) {
  const context = { userId };
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    const rows = await sql<{ id: string; status: string }>`
      select id, status from creative_records
      where id = ${data.creativeId} and brand_id = ${data.brandId} and organization_id = ${access.organizationId}
      limit 1
    `;
    if (!rows[0]) throw new Error("Variant not found.");
    if (rows[0].status === "rejected" && data.action === "approve") throw new Error("Brand Guardian rejected this. Approval is not available.");
    const rejectedByQa = await sql<{ decision: string }>`
      select decision from jev_decisions
      where subject_id = ${data.creativeId} and organization_id = ${access.organizationId} and decision = 'REJECT'
      limit 1
    `;
    if (rejectedByQa[0] && data.action === "approve") throw new Error("Brand Guardian rejected this. Approval is not available.");
    if (data.action === "revision") {
      await sql`update assets set review_status = 'revision' where creative_id = ${data.creativeId} and organization_id = ${access.organizationId}`;
      await sql`
        update jev_decisions set reviewer_id = ${context.userId}, reviewer_decision = 'revision', reviewer_note = ${data.note}, reviewed_at = now()
        where subject_id = ${data.creativeId} and organization_id = ${access.organizationId}
      `;
      return loadSession(sql, access.organizationId, data.brandId, access.role);
    }
    const next = data.action === "approve" ? "approved" : "rejected";
    await sql`update creative_records set status = ${next}, updated_at = now() where id = ${data.creativeId}`;
    await sql`
      update assets set review_status = ${next}, lifecycle = ${next === "approved" ? "approved" : "rejected"}
      where creative_id = ${data.creativeId} and organization_id = ${access.organizationId}
    `;
    await sql`
      update reviews set status = ${next}
      where creative_id = ${data.creativeId} and organization_id = ${access.organizationId} and status = 'open'
    `;
    await sql`
      update jev_decisions set reviewer_id = ${context.userId}, reviewer_decision = ${data.action}, reviewer_note = ${data.note}, reviewed_at = now()
      where subject_id = ${data.creativeId} and organization_id = ${access.organizationId}
    `;
    if (data.action === "reject") {
      await sql`
        insert into rejections (id, organization_id, brand_id, creative_id, reason_code, note, rejected_by)
        values (${crypto.randomUUID()}, ${access.organizationId}, ${data.brandId}, ${data.creativeId}, ${data.reasonCode}, ${data.note}, ${context.userId})
      `;
    }
    return loadSession(sql, access.organizationId, data.brandId, access.role);
}

export async function publishStudioVariant(userId: string, data: { brandId: string; creativeId: string; publisher: string }) {
  const context = { userId };
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    const rows = await sql<{ status: string }>`
      select status from creative_records
      where id = ${data.creativeId} and brand_id = ${data.brandId} and organization_id = ${access.organizationId} and origin = 'generated'
      limit 1
    `;
    if (!rows[0]) throw new Error("Variant not found.");
    if (rows[0].status !== "approved") throw new Error("Publish only an approved asset.");
    const asset = await sql<{ mime_type: string; width: number | null; height: number | null; byte_size: number | null; kind: string }>`
      select mime_type, width, height, byte_size, kind from assets
      where creative_id = ${data.creativeId} and organization_id = ${access.organizationId}
      order by created_at desc limit 1
    `;
    const readiness = assessPublishing({
      accounts: await accountSnapshots(sql, access.organizationId),
      provider: data.publisher === "test" ? "test:publisher" : data.publisher,
      kind: asset[0]?.kind === "video" ? "video" : "image",
      mime: asset[0]?.mime_type ?? "",
      width: asset[0]?.width ?? null,
      height: asset[0]?.height ?? null,
      byteSize: asset[0]?.byte_size ?? 0,
      destinationUrl: "",
    });
    if (data.publisher !== "test" && readiness.state !== "READY") {
      throw new Error(`${readiness.state}. ${readiness.summary}`);
    }
    if (asset[0]?.kind === "video") {
      if (data.publisher !== "test") throw new Error(`${readiness.state}. ${readiness.summary}`);
      await publishStudioHypitVideo(sql, {
        organizationId: access.organizationId,
        brandId: data.brandId,
        creativeId: data.creativeId,
        actorId: context.userId,
      });
      return loadSession(sql, access.organizationId, data.brandId, access.role);
    }
    const existing = await sql<{ external_id: string }>`
      select external_id from provider_objects
      where organization_id = ${access.organizationId} and provider = 'test' and object_type = 'ad' and idempotency_key = ${data.creativeId}
      limit 1
    `;
    if (!existing[0]) {
      const decision = decide(publishingReadiness, {
        providerConnected: data.publisher === "test" || readiness.state === "READY",
        creativeApproved: true,
        policyAllowsAutoPublish: false,
      }, {
        provider: data.publisher === "test" ? "test:publisher" : data.publisher,
        model: "account-v1",
      });
      const reasons = decision.reasons.some((line) => line === readiness.summary)
        ? decision.reasons
        : [...decision.reasons, readiness.summary];
      const publishInput = { state: readiness.state };
      const publishEvidence = decision.evidence.length > 0 ? decision.evidence : [{ id: "publish", source: "provider_connections", summary: readiness.summary }];
      // The stored reasons may add the readiness summary, so the digest covers what the row says, not the raw rule output.
      const publishRecord = ruleDecisionRecordFields({ ...decision, reasons }, { input: publishInput, evidence: publishEvidence });
      await sql`
        insert into jev_decisions (
          id, organization_id, brand_id, correlation_id, question_id, question_version, subject_type, subject_id,
          input, evidence, probability, confidence, thresholds, decision, reasons, provider, model,
          answer, schema_version, policy_version, calibration_version, decision_fingerprint, outcome_digest
        ) values (
          ${crypto.randomUUID()}, ${access.organizationId}, ${data.brandId}, ${data.creativeId}, ${decision.questionId},
          ${decision.questionVersion}, 'creative', ${data.creativeId}, ${JSON.stringify(publishInput)},
          ${JSON.stringify(publishEvidence)},
          ${decision.probability}, ${decision.confidence}, ${JSON.stringify(decision.thresholds)},
          ${decision.decision}, ${JSON.stringify(reasons)}, ${decision.provider}, ${decision.model},
          ${JSON.stringify(decision.answer)}, ${decision.schemaVersion}, ${decision.policyVersion}, ${decision.calibrationVersion ?? ""},
          ${publishRecord.decisionFingerprint}, ${publishRecord.outcomeDigest}
        )
      `;
      const isTest = data.publisher === "test";
      const isTestRuntime = isTestingRuntimeNow();
      if (isTest && !isTestRuntime) {
        throw new Error("The test publisher is isolated to TestingRuntime and cannot be used in ProductionRuntime. Connect a live channel to publish.");
      }
      const publisherProvider = isTest ? "test" : (data.publisher as any);
      const result = publishThrough({
        provider: publisherProvider,
        creativeId: data.creativeId,
        allowTestProvider: isTest && isTestRuntime,
      });
      if (!result.externalId) {
        throw new Error(`The publisher (${data.publisher}) did not return an external id (${result.status}). Nothing was stored.`);
      }
      await sql`
        insert into provider_objects (
          id, organization_id, brand_id, provider, object_type, idempotency_key, external_id, status
        ) values (
          ${crypto.randomUUID()}, ${access.organizationId}, ${data.brandId}, ${publisherProvider}, 'ad', ${data.creativeId},
          ${result.externalId}, ${result.status}
        )
      `;
      await sql`
        update assets set lifecycle = 'published', review_status = 'published'
        where creative_id = ${data.creativeId} and organization_id = ${access.organizationId}
      `;
      await sql`update creative_records set status = 'testing', updated_at = now() where id = ${data.creativeId}`;
    }
    return loadSession(sql, access.organizationId, data.brandId, access.role);
}

export async function recordStudioTestPerformance(userId: string, data: { brandId: string }) {
  if (!isTestingRuntimeNow()) {
    throw new Error("Simulated performance is recorded only in the testing runtime. It is never used as a real outcome.");
  }
  const context = { userId };
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    const published = await sql<{ idempotency_key: string }>`
      select idempotency_key from provider_objects
      where brand_id = ${data.brandId} and organization_id = ${access.organizationId} and provider = 'test' and object_type = 'ad'
    `;
    if (published.length === 0) throw new Error("Publish an approved variant with the test publisher before recording test performance.");
    const siblings = await sql<{ id: string; status: string }>`
      select id, status from creative_records
      where brand_id = ${data.brandId} and organization_id = ${access.organizationId}
        and origin = 'generated' and status in ('approved', 'testing')
    `;
    const targets = siblings.length > 0 ? siblings : published.map((row) => ({ id: row.idempotency_key, status: "testing" }));
    for (const creative of targets) {
      const event = testProviderPerformance(creative.id, true);
      const prior = await sql<{ id: string }>`
        select id from performance_observations
        where creative_id = ${creative.id} and source = 'test:performance' and organization_id = ${access.organizationId}
        limit 1
      `;
      if (prior[0]) continue;
      await sql`
        insert into performance_observations (
          id, organization_id, brand_id, creative_id, platform, impressions, clicks, conversions,
          spend_cents, revenue_cents, observed_on, source, created_by
        ) values (
          ${crypto.randomUUID()}, ${access.organizationId}, ${data.brandId}, ${creative.id}, 'test',
          ${event.impressions}, ${event.clicks}, ${event.conversions}, ${event.spendCents}, ${event.revenueCents},
          ${event.observedOn}, 'test:performance', ${context.userId}
        )
      `;
    }
    const learningId = crypto.randomUUID();
    await sql`
      insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, payload)
      values (
        ${learningId}, ${access.organizationId}, ${data.brandId}, 'learning.update', ${`learning.studio:${learningId}`},
        'queued', ${JSON.stringify({ organizationId: access.organizationId })}
      )
    `;
    await claimAndRun(sql, learningId);
    const refreshId = crypto.randomUUID();
    await sql`
      insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, payload)
      values (
        ${refreshId}, ${access.organizationId}, ${data.brandId}, 'opportunity.refresh', ${`rerank.studio:${refreshId}`},
        'queued', ${JSON.stringify({ organizationId: access.organizationId })}
      )
    `;
    await claimAndRun(sql, refreshId);
    await applyLearnedPatterns(sql, access.organizationId, data.brandId);
    return loadSession(sql, access.organizationId, data.brandId, access.role);
}
