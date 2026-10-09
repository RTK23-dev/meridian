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
import { loadAppliedPolicies } from "../jev/policy.ts";
import { generationAllowed } from "../security/budget.ts";
import { evaluateJevGate } from "../jev/reviewer-decision.ts";
import { judgeBrief, judgeMedia, rollupDecision, type MediaFacts } from "./features.ts";
import { STUDIO_PROMPT_VERSION, storeBlob, variantPrompt } from "./media-work.ts";
import { publishStudioHypitVideo } from "./hypit-run.ts";
import { productionRouter } from "../production/router.ts";
import { ensureLocalSemantic, readSemanticClusters, semanticNearest } from "../embeddings/store.ts";
import { assessPublishing, type AccountSnapshot } from "../publishing/readiness.ts";
import { combineLogoFrames, combinePaletteFrames, measureLogo, measurePalette } from "../vision/measure.ts";
import type { MarketCluster } from "../intelligence/whitespace.ts";
import { CreativeDecisionEngine } from "../creative/engine.ts";
import type { CreationScope, AutonomyMode, CreativeJudgmentBundle, CreativePlan } from "../creative/plan.ts";
import { finalizeProductionArtifact } from "../production/artifact-finalizer.ts";
import { BudgetLedgerService, InvalidBudgetCapError, toMicros } from "../security/budget-ledger.ts";
import { modelCapabilityRegistry } from "../production/registry.ts";
import { creativeSpecFromManifest } from "../production/spec-from-manifest.ts";
import { resolveProductionTarget } from "../production/target.ts";
import { transitionCreativePlan } from "../creative/state-transition.server.ts";
import { creativeJudgmentsFromStoredDecision } from "./jev-context.ts";

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
  const blobByKey = new Map(blobs.map((row) => [row.storage_key, row]));
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
      const blob = blobByKey.get(asText(row.storage_key));
      const preview = blob && asText(row.kind) === "image" && blob.body.length < 120_000
        ? `data:${blob.mime_type};base64,${blob.body}`
        : "";
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
    if (existing[0]?.decision_id) {
      await sql`
        update jev_decisions set reviewer_id = ${context.userId}, reviewer_decision = 'approve', reviewed_at = now()
        where id = ${existing[0].decision_id} and organization_id = ${access.organizationId}
      `;
    }
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
      const policies = await loadAppliedPolicies(sql, access.organizationId);
      const gate = judgeBrief({
        audience: brief.audience,
        hook: brief.hook,
        message: brief.message,
        format: brief.format,
        cta: brief.cta,
        angle: brief.angle,
      }, policies.get("brief_completeness"));
      if (gate.decision === "REJECT") {
        throw new Error("The brief gate rejected this. A person was not asked to ignore a stored rejection.");
      }
      await sql`
        insert into jev_decisions (
          id, organization_id, brand_id, correlation_id, question_id, question_version,
          subject_type, subject_id, input, evidence, probability, confidence, thresholds, decision, reasons,
          provider, model, answer, schema_version, policy_version, calibration_version,
          reviewer_id, reviewer_decision, reviewed_at
        ) values (
          ${decisionId}, ${access.organizationId}, ${data.brandId}, ${crypto.randomUUID()},
          ${gate.questionId}, ${gate.questionVersion}, 'brief', ${briefId}, ${JSON.stringify(gate.features)},
          ${JSON.stringify(gate.evidence)}, ${gate.probability}, ${gate.confidence}, ${JSON.stringify(gate.policy)},
          ${gate.decision}, ${JSON.stringify(gate.reasons)}, ${gate.provider}, ${gate.modelVersion},
          ${JSON.stringify(gate.answer)}, ${gate.schemaVersion}, ${gate.policyVersion}, ${gate.calibrationVersion ?? ""},
          ${context.userId}, 'approve', now()
        )
      `;
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
          ${JSON.stringify(brief.failureNotes)}, 'ready', ${decisionId}, ${context.userId}
        )
      `;
      await sql`update opportunities set status = 'briefed' where id = ${opportunityId}`;
    }
    return loadSession(sql, access.organizationId, data.brandId, access.role);
}

function frameLike(storageKey: string): string {
  return `${storageKey.replace(/[\\%_]/g, (char) => `\\${char}`)}.frame.%`;
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

async function visualFacts(sql: Sql, organizationId: string, brandId: string, bytes: Uint8Array) {
  const logos = await sql<{ body: string }>`
    select body from assets
    where brand_id = ${brandId} and organization_id = ${organizationId} and label = 'logo' and status = 'stored'
    order by created_at desc
    limit 1
  `;
  const colors = await sql<{ colors: string }>`
    select colors from brand_brains where brand_id = ${brandId} limit 1
  `;
  const logo = logos[0]?.body ? Buffer.from(logos[0].body, "base64") : null;
  const measuredLogo = measureLogo(logo, bytes);
  const measuredPalette = measurePalette(colors[0]?.colors ?? "", bytes);
  return { measuredLogo, measuredPalette };
}

async function accountSnapshots(sql: Sql, organizationId: string): Promise<AccountSnapshot[]> {
  const rows = await sql<{ provider: string; status: string; account_id: string; permissions: string }>`
    select provider, status, account_id, permissions from provider_connections
    where organization_id = ${organizationId}
  `;
  return rows.map((row) => {
    let permissions: string[] = [];
    try {
      const parsed = JSON.parse(row.permissions) as unknown;
      permissions = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      permissions = [];
    }
    return {
      provider: row.provider,
      status: row.status,
      accountId: row.account_id,
      permissions,
      pageId: "",
      destinationUrl: "",
    };
  });
}

function competitorCopy(loaded: Awaited<ReturnType<typeof loadBrandContext>>): string[] {
  return loaded.creatives.filter((item) => item.origin === "competitor").map((item) => item.text);
}

function factsFor(
  loaded: Awaited<ReturnType<typeof loadBrandContext>>,
  input: Omit<MediaFacts, "positioning" | "tone" | "prohibited" | "wordsToAvoid" | "competitorTexts" | "ownTexts">,
): MediaFacts {
  return {
    ...input,
    positioning: `${loaded.brain.positioning}\n${loaded.brain.valueProposition}`,
    tone: loaded.brain.tone,
    prohibited: loaded.brain.prohibitedClaims,
    wordsToAvoid: loaded.brain.wordsToAvoid,
    competitorTexts: loaded.creatives.filter((item) => item.origin === "competitor").map((item) => item.text),
    ownTexts: loaded.creatives.filter((item) => item.origin !== "competitor").map((item) => item.text),
  };
}

async function writeJudgment(
  sql: Sql,
  input: { organizationId: string; brandId: string; creativeId: string; facts: MediaFacts },
): Promise<{ rollup: string; decisionId: string }> {
  const policies = await loadAppliedPolicies(sql, input.organizationId);
  const decisions = judgeMedia(input.facts, policies);
  const rollup = rollupDecision(decisions);
  let pointed = "";
  for (const decision of decisions) {
    const id = crypto.randomUUID();
    if (!pointed && decision.decision === rollup) pointed = id;
    await sql`
      insert into jev_decisions (
        id, organization_id, brand_id, correlation_id, question_id, question_version, subject_type, subject_id,
        input, evidence, probability, confidence, thresholds, decision, reasons, provider, model,
        answer, schema_version, policy_version, calibration_version
      ) values (
        ${id}, ${input.organizationId}, ${input.brandId}, ${input.creativeId}, ${decision.questionId},
        ${decision.questionVersion}, 'creative', ${input.creativeId}, ${JSON.stringify(decision.features)},
        ${JSON.stringify(decision.evidence)}, ${decision.probability}, ${decision.confidence},
        ${JSON.stringify(decision.policy)}, ${decision.decision}, ${JSON.stringify(decision.reasons)},
        ${decision.provider}, ${decision.modelVersion},
        ${JSON.stringify(decision.answer)}, ${decision.schemaVersion}, ${decision.policyVersion}, ${decision.calibrationVersion ?? ""}
      )
    `;
  }
  return { rollup, decisionId: pointed };
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

    // Load persisted JEV decision bundle (P0-A, P0-2)
    let jevBundle: CreativeJudgmentBundle | undefined;
    if (brief.decision_id) {
      const decisionRows = await sql<{
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
      }>`
        select id, decision, reviewer_decision, evidence, answer, subject_type, schema_version,
               model_response, provider, model, question_id, question_version, reasons, probability, confidence
        from jev_decisions
        where id = ${asText(brief.decision_id)} and organization_id = ${access.organizationId} and brand_id = ${data.brandId}
        limit 1
      `;
      const dec = decisionRows[0];
      if (dec) {
        // Enforce Decision Semantics via centralized evaluateJevGate (P0-2)
        const gate = evaluateJevGate({
          decision: dec.decision,
          reviewerDecision: dec.reviewer_decision,
        });
        if (gate.status === "BLOCK") {
          throw new Error(`JEV policy rejected this brief: ${gate.reason}. Creative production is blocked.`);
        }
        if (gate.status === "REQUIRE_HUMAN") {
          throw new Error("JEV requires recorded human review for this brief before production can proceed.");
        }

        jevBundle = creativeJudgmentsFromStoredDecision({
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
      }
    }

    // Build CreativePlan via CreativeDecisionEngine (P0.5, P1.1, P0-A)
    const creativePlan = CreativeDecisionEngine.createPlan({
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
    await sql`
      insert into creative_plans (
        id, organization_id, brand_id, brief_id, version, status, scope, autonomy, objective,
        plan_payload, budget_reserved_usd, spend_cap_usd, created_at, updated_at
      ) values (
        ${creativePlan.id}, ${access.organizationId}, ${data.brandId}, ${data.briefId},
        ${creativePlan.version}, ${creativePlan.status}, ${creativePlan.scope}, ${creativePlan.autonomy},
        ${creativePlan.objective}, ${JSON.stringify(creativePlan)},
        ${creativePlan.estimatedCost.totalEstimatedUsd}, ${data.maxSpendUsd ?? null}, now(), now()
      )
      on conflict (id) do update set
        status = excluded.status,
        plan_payload = excluded.plan_payload,
        updated_at = now()
    `;

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

    return executeApprovedCreativePlan(sql, access, context.userId, creativePlan, brief);
}

/**
 * Budget reservation amount for an approved plan. Fails closed.
 * A missing, non-finite, negative, or zero estimate reserves nothing only when every
 * deliverable's provider/model pair is registered as free of charge. Otherwise it is refused
 * before any provider call. A positive estimate is reserved exactly, in integer micros.
 */
function planReservationMicros(plan: CreativePlan): bigint | null {
  const allFree = plan.deliverables.every((d) => modelCapabilityRegistry.isEstablishedFree(d.provider, d.model));
  const total = plan.estimatedCost?.totalEstimatedUsd;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
    if (allFree) return null;
    throw new InvalidBudgetCapError(
      `Cost estimate is missing or invalid (${String(total)}) for a billable plan. Budget reservation refused; no provider was called.`
    );
  }
  if (total === 0) {
    if (allFree) return null;
    throw new InvalidBudgetCapError(
      "Zero cost estimate for a billable provider. Budget reservation refused; no provider was called."
    );
  }
  return toMicros(total);
}

export async function executeApprovedCreativePlan(
  sql: Sql,
  access: { organizationId: string; role: Role },
  userId: string,
  creativePlan: CreativePlan,
  brief: Record<string, unknown>,
) {
  const brandId = asText(brief.brand_id);
  const persistedPlan = await sql<{ status: string }>`
    select status from creative_plans
    where id = ${creativePlan.id} and organization_id = ${access.organizationId} and brand_id = ${brandId}
    limit 1
  `;
  if (persistedPlan[0]?.status !== "executing") {
    throw new Error("CreativePlan must be durably approved and executing before provider calls.");
  }
  const loaded = await loadBrandContext(sql, access.organizationId, brandId);
  assertSameTenant(loaded.creatives, access.organizationId, brandId);
  const productName = loaded.products[0]?.name || asText(brief.title);

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
      audience: asText(brief.audience),
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
    conceptId: asText(brief.opportunity_id) || crypto.randomUUID(),
    mode,
    startingMaterial: "new_brief",
    productionStrategy: "automated_provider",
    brand: {
      organizationId: access.organizationId,
      brandId,
      product: productName,
      audience: asText(brief.audience),
      objective: asText(brief.angle),
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
        'studio.research_manifest_created', 'brief', ${asText(brief.id)},
        ${JSON.stringify({ manifestId: manifest.creativeId, mode: manifest.mode, beats: manifest.beats.length, planId: creativePlan.id })}
      )
    `;
    await sql`update briefs set status = 'used' where id = ${asText(brief.id)}`;
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

  let reservationId: string | null = null;
  // Set once provider I/O may have begun, and cleared only when the provider definitively
  // rejects the job. While set, the reservation is never released: the job may be billable.
  let reservationHeld = false;
  let providerSubmissionUnknown = false;
  const estimatedUsd = creativePlan.estimatedCost?.totalEstimatedUsd ?? 0;
  try {
    const reservationMicros = planReservationMicros(creativePlan);
    if (reservationMicros !== null) {
      const reservation = await BudgetLedgerService.reserve(sql, {
        organizationId: access.organizationId,
        brandId,
        amountMicros: reservationMicros,
        creativePlanId: creativePlan.id,
      });
      reservationId = reservation.id;
    }
  } catch (budgetErr) {
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
  const firstImgDeliv = creativePlan.deliverables.find((d) => d.kind === "image" || d.kind === "carousel_slide");
  const firstVidDeliv = creativePlan.deliverables.find((d) => d.kind === "video");
  const effectiveImageProvider = firstImgDeliv?.provider || "none";
  const effectiveVideoProvider = firstVidDeliv?.provider || "none";

  await sql`
    insert into generation_runs (
      id, organization_id, brand_id, opportunity_id, brief_id, prompt_version, image_provider, video_provider, status, created_by
    ) values (
      ${runId}, ${access.organizationId}, ${brandId}, ${asText(brief.opportunity_id) || null}, ${asText(brief.id)},
      ${STUDIO_PROMPT_VERSION}, ${effectiveImageProvider}, ${effectiveVideoProvider}, 'running', ${userId}
    )
  `;

  try {
    const { generateImageBytes } = await import("../providers/image-bytes.server.ts");

    for (const deliv of creativePlan.deliverables) {
      if (deliv.kind === "image" || deliv.kind === "carousel_slide") {
        const index = deliv.sequenceIndex ?? 0;
        const delivManifest = deliverableManifests.find((m) => m.deliverableId === deliv.id);
        if (!delivManifest) throw new Error(`CreativePlan deliverable ${deliv.id} has no executable manifest.`);
        const prompt = variantPrompt({
          productName,
          angle: delivManifest.concept?.mechanism || "",
          hook: delivManifest.hook?.text || "",
          audience: delivManifest.brand.audience,
          constraints: creativePlan.constraintsApplied.map((constraint) => `${constraint.constraintName}: ${String(constraint.constraintValue)}`).join("; "),
          index,
          kind: "image",
        });
        const creativeId = crypto.randomUUID();
        const assetId = crypto.randomUUID();
        const imageTarget = resolveProductionTarget({
          provider: delivManifest.production!.provider,
          model: delivManifest.production!.model,
          capability: "IMAGE_GENERATION",
          aspectRatio: delivManifest.format.aspectRatio,
        });
        const imgProvider = imageTarget.provider === "google_nano_banana" ? "google:nano-banana" : imageTarget.provider;

        const image = await generateImageBytes({
          provider: imgProvider,
          prompt,
          seed: `${runId}:${deliv.kind}:${index}`,
          promptVersion: `${STUDIO_PROMPT_VERSION}#${deliv.kind}-${index + 1}`,
          allowTest: imgProvider === "test:image",
          model: imageTarget.model,
          aspectRatio: delivManifest.format.aspectRatio,
        });

        if (image.status !== "ready") {
          await sql`
            insert into generation_jobs (
              id, organization_id, brand_id, brief_id, correlation_id, provider, model, prompt_id, prompt_version,
              status, error, created_by
            ) values (
              ${crypto.randomUUID()}, ${access.organizationId}, ${brandId}, ${asText(brief.id)}, ${runId},
              ${image.provider}, '', 'studio_media', ${`${STUDIO_PROMPT_VERSION}#${deliv.kind}-${index + 1}`},
              ${image.status}, ${image.error.slice(0, 500)}, ${userId}
            )
          `;
          continue;
        }

        const key = `${access.organizationId}/${brandId}/runs/${runId}/${assetId}.img`;
        const stored = await storeBlob(sql, {
          organizationId: access.organizationId,
          brandId,
          key,
          mime: image.mediaType,
          bytes: image.bytes,
        });
        const copy = `${productName}. ${prompt}`;
        const visual = await visualFacts(sql, access.organizationId, brandId, image.bytes);
        const ownSemantic = await semanticNearest(copy, loaded.creatives.filter((item) => item.origin !== "competitor").map((item) => item.text)).catch(() => null);
        const accounts = await accountSnapshots(sql, access.organizationId);
        const publishing = assessPublishing({
          accounts,
          provider: "test:publisher",
          kind: "image",
          mime: image.mediaType,
          width: image.width,
          height: image.height,
          byteSize: stored.byteSize,
          destinationUrl: "",
        });
        const facts = factsFor(loaded, {
          kind: "image",
          productName,
          angle: delivManifest.concept?.mechanism || "",
          copy,
          prompt,
          mime: image.mediaType,
          byteSize: stored.byteSize,
          width: image.width,
          height: image.height,
          checksum: stored.checksum,
          durationMs: null,
          transcript: "",
          sceneCount: 0,
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
          creativeId,
          facts,
        });
        const status = judged.rollup === "REJECT" ? "rejected" : judged.rollup === "AUTO_APPROVE" ? "approved" : "in_review";
        const itemLabel = deliv.kind === "carousel_slide" ? `carousel slide ${index + 1}` : `image ${index + 1}`;

        await sql`
          insert into creative_records (
            id, organization_id, brand_id, origin, title, raw_text, product_name, hook, hook_type, angle,
            message, cta, format, proof_type, opportunity_id, brief_id, status, created_by, workflow
          ) values (
            ${creativeId}, ${access.organizationId}, ${brandId}, 'generated', ${`${asText(brief.title)} ${itemLabel}`},
            ${copy}, ${productName}, ${delivManifest.hook?.text || ""}, ${delivManifest.hook?.type || ""}, ${delivManifest.concept?.mechanism || ""},
            ${copy}, ${""}, ${deliv.format}, ${""},
            ${asText(brief.opportunity_id) || null}, ${asText(brief.id)}, ${status}, ${userId},
            ${JSON.stringify({ generationRunId: runId, jevDecisionId: asText(brief.decision_id), provider: image.provider, model: image.model, promptVersion: image.promptVersion, kind: deliv.kind, variant: index + 1, planDeliverableId: deliv.id })}
          )
        `;
        await sql`
          insert into assets (
            id, organization_id, brand_id, creative_id, version, storage_key, content_hash, mime_type, source, status,
            lifecycle, checksum, width, height, byte_size, provider, model, prompt_version, generation_run_id, kind,
            qa_decision, review_status, media_status, variant_index, provenance
          ) values (
            ${assetId}, ${access.organizationId}, ${brandId}, ${creativeId}, 1, ${key}, ${stored.checksum},
            ${image.mediaType}, ${image.provider}, 'stored', 'qa_required', ${stored.checksum}, ${image.width}, ${image.height},
            ${stored.byteSize}, ${image.provider}, ${image.model}, ${image.promptVersion}, ${runId}, ${deliv.kind},
            ${judged.rollup}, ${status}, 'completed', ${index}, 'generated'
          )
        `;
        if (status === "in_review") {
          await sql`
            insert into reviews (id, organization_id, brand_id, decision_id, creative_id, subject_label)
            values (${crypto.randomUUID()}, ${access.organizationId}, ${brandId}, ${judged.decisionId}, ${creativeId}, ${deliv.kind === "carousel_slide" ? `Slide ${index + 1}` : `Image ${index + 1}`})
          `;
        }
        await sql`
          insert into generation_jobs (
            id, organization_id, brand_id, brief_id, correlation_id, provider, model, prompt_id, prompt_version,
            status, output, creative_id, created_by
          ) values (
            ${crypto.randomUUID()}, ${access.organizationId}, ${brandId}, ${asText(brief.id)}, ${runId},
            ${image.provider}, ${image.model}, 'studio_media', ${image.promptVersion}, 'completed',
            ${prompt.slice(0, 2000)}, ${creativeId}, ${userId}
          )
        `;
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
          where id = ${asText(brief.decision_id)} and organization_id = ${access.organizationId} and brand_id = ${brandId}
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
          title: asText(brief.title),
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
        const provider = await productionRouter.route(
          creativeSpec,
          "BALANCED",
          targetVidProvider === "auto" ? undefined : targetVidProvider,
        );
        const prodJobId = crypto.randomUUID();
        creativeSpec.idempotencyKey = prodJobId;
        const durableInput = JSON.stringify({
          creativeSpec, runId, briefId: asText(brief.id), manifestId: delivManifest.creativeId,
          manifest: delivManifest, planDeliverableId: deliv.id,
        });
        await sql`
          insert into production_jobs (
            id, organization_id, brand_id, provider, provider_job_id, request_id, status_url, cancel_url,
            status, cost_mode, estimated_cost_cents, input, created_at, submitted_at, updated_at
          ) values (
            ${prodJobId}, ${access.organizationId}, ${brandId}, ${provider.id}, null, null, null, null,
            'SUBMITTING', 'BALANCED', ${Math.round(creativeSpec.durationTargetSeconds * provider.capabilities.costPerSecondEstimateUsd * 100)},
            ${durableInput}, now(), null, now()
          )
          on conflict (id) do nothing
        `;
        let submittedJob: import("../production/types.ts").ProductionJob;
        reservationHeld = true;
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
          reservationHeld = false;
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
          const videoCreativeId = crypto.randomUUID();
          const videoAssetId = crypto.randomUUID();
          const videoCopy = `${productName}. ${creativeSpec.script}`;
          const storageKey = finalResult.storageKey || `${access.organizationId}/${brandId}/runs/${runId}/${videoAssetId}.mp4`;

          await sql`
            insert into creative_records (
              id, organization_id, brand_id, origin, title, raw_text, product_name, hook, hook_type, angle,
              message, cta, format, proof_type, opportunity_id, brief_id, status, created_by, workflow
            ) values (
              ${videoCreativeId}, ${access.organizationId}, ${brandId}, 'generated', ${`${asText(brief.title)} video`},
              ${videoCopy}, ${productName}, ${creativeSpec.hookLine}, ${"problem"}, ${delivManifest.concept?.mechanism || ""},
              ${creativeSpec.script}, ${""}, ${creativeSpec.format}, ${""},
              ${asText(brief.opportunity_id) || null}, ${asText(brief.id)}, 'in_review', ${userId},
              ${JSON.stringify({
                generationRunId: runId,
                provider: provider.id,
                providerJobId: submittedJob.jobId,
                productionJobId: prodJobId,
                jevDecisionId: asText(brief.decision_id),
                kind: "video",
                planDeliverableId: deliv.id,
              })}
            )
          `;

          const videoMime = finalResult.mimeType;
          if (!videoMime) throw new Error("Finalized video artifact has no verified MIME type.");
          await sql`
            insert into assets (
              id, organization_id, brand_id, creative_id, version, storage_key, content_hash, mime_type, source, status,
              lifecycle, checksum, width, height, byte_size, duration_ms, provider, model, prompt_version, generation_run_id,
              kind, qa_decision, review_status, media_status, variant_index, provenance
            ) values (
              ${videoAssetId}, ${access.organizationId}, ${brandId}, ${videoCreativeId}, 1, ${storageKey}, ${finalResult.sha256 || ""},
              ${videoMime}, ${provider.id}, 'stored', 'qa_required', ${finalResult.sha256 || ""}, 1080, 1920,
              ${finalResult.byteSize || 0}, 8000, ${provider.id}, ${provider.id}, 'studio_video_v1', ${runId},
              'video', '', 'in_review', 'completed', 0, 'generated'
            )
          `;
        }
      }
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
      });
      const status = judged.rollup === "REJECT" ? "rejected" : "in_review";
      await sql`update creative_records set status = ${status}, updated_at = now() where id = ${asText(video.creative_id)}`;
      await sql`
        update assets set qa_decision = ${judged.rollup}, review_status = ${status}, lifecycle = 'qa_required'
        where id = ${asText(video.id)}
      `;
      if (status === "in_review") {
        await sql`
          insert into reviews (id, organization_id, brand_id, decision_id, creative_id, subject_label)
          values (${crypto.randomUUID()}, ${access.organizationId}, ${brandId}, ${judged.decisionId}, ${asText(video.creative_id)}, 'Video')
        `;
      }
    }

    if (reservationId && !providerSubmissionUnknown) {
      await BudgetLedgerService.reconcile(sql, {
        reservationId,
        cost: { basis: "ESTIMATED", amountMicros: toMicros(estimatedUsd), estimatorVersion: "creative-plan-estimate-v1" },
      });
    }

    await sql`update briefs set status = 'used' where id = ${asText(brief.id)}`;
    await sql`update generation_runs set status = 'completed' where id = ${runId}`;
    await transitionCreativePlan(sql, {
      organizationId: access.organizationId, brandId, planId: creativePlan.id, actorId: userId,
      target: "completed", reason: "All planned deliverables completed.",
    });
    return loadSession(sql, access.organizationId, brandId, access.role);
  } catch (error) {
    if (reservationId && !reservationHeld) {
      await BudgetLedgerService.release(sql, {
        reservationId,
        reason: error instanceof Error ? error.message : String(error),
      }).catch(() => {});
    }
    await sql`
      update generation_runs set status = 'failed'
      where id = ${runId} and organization_id = ${access.organizationId} and status = 'running'
    `;
    await transitionCreativePlan(sql, {
      organizationId: access.organizationId, brandId, planId: creativePlan.id, actorId: userId,
      target: "failed", reason: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
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
  return executeApprovedCreativePlan(sql, access, userId, planPayload, brief);
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
      await sql`
        insert into jev_decisions (
          id, organization_id, brand_id, correlation_id, question_id, question_version, subject_type, subject_id,
          input, evidence, probability, confidence, thresholds, decision, reasons, provider, model,
          answer, schema_version, policy_version, calibration_version
        ) values (
          ${crypto.randomUUID()}, ${access.organizationId}, ${data.brandId}, ${data.creativeId}, ${decision.questionId},
          ${decision.questionVersion}, 'creative', ${data.creativeId}, ${JSON.stringify({ state: readiness.state })},
          ${JSON.stringify(decision.evidence.length > 0 ? decision.evidence : [{ id: "publish", source: "provider_connections", summary: readiness.summary }])},
          ${decision.probability}, ${decision.confidence}, ${JSON.stringify(decision.thresholds)},
          ${decision.decision}, ${JSON.stringify(reasons)}, ${decision.provider}, ${decision.model},
          ${JSON.stringify(decision.answer)}, ${decision.schemaVersion}, ${decision.policyVersion}, ${decision.calibrationVersion ?? ""}
        )
      `;
      const isTest = data.publisher === "test";
      const isTestRuntime = process.env.NODE_ENV !== "production" || process.env.MERIDIAN_TESTING_RUNTIME === "true";
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
