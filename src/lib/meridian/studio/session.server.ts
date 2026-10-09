import { getSql } from "@/lib/db";
import { assertRole, isRole, type Role } from "@/lib/meridian/access";
import { buildBrief } from "@/lib/meridian/brief/engine";
import { loadBrandContext } from "@/lib/meridian/context/load";
import { assertSameTenant } from "@/lib/meridian/domain";
import type { Sql } from "@/lib/meridian/learning/store";
import { applyLearnedPatterns } from "@/lib/meridian/learning/store";
import { learningDirection } from "@/lib/meridian/learning/engine";
import { fingerprintCreative } from "@/lib/meridian/intelligence/fingerprint";
import { findWhitespace } from "@/lib/meridian/intelligence/whitespace";
import { hypothesisById } from "@/lib/meridian/opportunity/catalog";
import { rankOpportunities, recommendationPosture, type OpportunityDraft } from "@/lib/meridian/opportunity/engine";
import { rerankBrand } from "@/lib/meridian/opportunity/rerank";
import { publishThrough } from "@/lib/meridian/providers/boundaries";
import { testProviderPerformance } from "@/lib/meridian/providers/test-provider";
import { claimAndRun } from "@/lib/meridian/jobs/sql-worker";
import { decide } from "@/lib/meridian/jev/engine";
import { publishingReadiness } from "@/lib/meridian/jev/guards";
import { loadAppliedPolicies } from "@/lib/meridian/jev/policy";
import { generationAllowed } from "@/lib/meridian/security/budget";
import { judgeBrief, judgeMedia, rollupDecision, type MediaFacts } from "./features";
import { STUDIO_PROMPT_VERSION, storeBlob, variantPrompt } from "./media-work";
import { publishStudioHypitVideo } from "./hypit-run.ts";
import { productionRouter } from "../production/router.ts";
import type { CreativeSpec } from "../production/types.ts";
import { ensureLocalSemantic, readSemanticClusters, semanticNearest } from "../embeddings/store";
import { assessPublishing, type AccountSnapshot } from "../publishing/readiness";
import { combineLogoFrames, combinePaletteFrames, measureLogo, measurePalette } from "../vision/measure";
import type { MarketCluster } from "../intelligence/whitespace";
import { CreativeDecisionEngine } from "../creative/engine.ts";
import type { CreationScope, AutonomyMode } from "../creative/plan.ts";
import { finalizeProductionArtifact } from "../production/artifact-finalizer.ts";

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
    const existing = await sql<{ id: string }>`
      select id from briefs
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
          provider, model, answer, schema_version, policy_version, calibration_version
        ) values (
          ${decisionId}, ${access.organizationId}, ${data.brandId}, ${crypto.randomUUID()},
          ${gate.questionId}, ${gate.questionVersion}, 'brief', ${briefId}, ${JSON.stringify(gate.features)},
          ${JSON.stringify(gate.evidence)}, ${gate.probability}, ${gate.confidence}, ${JSON.stringify(gate.policy)},
          ${gate.decision}, ${JSON.stringify(gate.reasons)}, ${gate.provider}, ${gate.modelVersion},
          ${JSON.stringify(gate.answer)}, ${gate.schemaVersion}, ${gate.policyVersion}, ${gate.calibrationVersion ?? ""}
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
    mode?: import("@/lib/meridian/factory/creative-manifest").CreationMode;
    creationScope?: CreationScope;
    autonomy?: AutonomyMode;
    source?: import("@/lib/meridian/factory/creative-manifest").StartingMaterialType;
    productionMode?: import("@/lib/meridian/factory/creative-manifest").ProductionStrategyType;
    aspectRatio?: "9:16" | "16:9" | "1:1" | "4:5";
  },
) {
  const context = { userId };
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
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
    const creationScope: CreationScope = data.creationScope || (
      data.mode === "image_ad" || data.mode === "organic_image" ? "image_only" :
      data.mode === "video" || data.mode === "video_reel_short" ? "video_only" :
      data.mode === "carousel" ? "carousel_only" :
      data.mode === "mixed_format" ? "mixed_campaign" :
      data.mode === "research_only" ? "research_only" :
      "auto_choose"
    );
    const autonomy: AutonomyMode = data.autonomy || "semi_automatic";

    // Build CreativePlan via CreativeDecisionEngine (P0.5, P1.1)
    const creativePlan = CreativeDecisionEngine.createPlan({
      scope: creationScope,
      autonomy,
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
    });

    const mode = data.mode || (data.videoProvider && data.videoProvider !== "none" ? "video" : "image_ad");
    const startingMaterial = data.source || "new_brief";
    const productionStrategy = data.productionMode || (data.videoProvider === "manual_cloud" ? "manual_cloud" : "automated_provider");
    const aspectRatio = data.aspectRatio || "9:16";

    const { validateCreationPlan, buildCreativeManifest } = await import("@/lib/meridian/factory/creative-manifest");

    let beats: import("@/lib/meridian/factory/creative-manifest").CreativeManifestBeat[] = [];
    let targetDurationSeconds: number | undefined;
    let slideCount: number | undefined;

    if (mode === "research_only") {
      targetDurationSeconds = undefined;
      beats = [];
    } else if (mode === "image_ad" || mode === "organic_image") {
      targetDurationSeconds = undefined;
      beats = [
        {
          id: "hero",
          purpose: "hook",
          visualInstruction: asText(brief.hook || brief.title),
          onScreenText: asText(brief.cta || brief.hook),
        },
      ];
    } else if (mode === "carousel") {
      slideCount = 3;
      targetDurationSeconds = undefined;
      beats = [
        { id: "slide-1", purpose: "hook", visualInstruction: asText(brief.hook), onScreenText: asText(brief.hook) },
        { id: "slide-2", purpose: "mechanism_proof", visualInstruction: asText(brief.message), scriptOrCaption: asText(brief.message) },
        { id: "slide-3", purpose: "offer_cta", visualInstruction: asText(brief.cta), onScreenText: asText(brief.cta) },
      ];
    } else {
      // video, video_reel_short, mixed_format
      targetDurationSeconds = 8;
      beats = [
        { id: "beat-1", purpose: "hook", targetDurationSeconds: 2, visualInstruction: asText(brief.hook), onScreenText: asText(brief.hook) },
        { id: "beat-2", purpose: "mechanism", targetDurationSeconds: 4, visualInstruction: asText(brief.message), scriptOrCaption: asText(brief.message) },
        { id: "beat-3", purpose: "payoff_cta", targetDurationSeconds: 2, visualInstruction: asText(brief.cta), onScreenText: asText(brief.cta) },
      ];
    }

    const plan = validateCreationPlan({
      mode,
      startingMaterial,
      productionStrategy,
      slideCount,
      beats,
    });

    if (!plan.valid) {
      throw new Error(`Creative plan invalid: ${plan.reason}`);
    }

    const manifest = buildCreativeManifest({
      creativeId: crypto.randomUUID(),
      conceptId: asText(brief.opportunity_id) || crypto.randomUUID(),
      mode,
      startingMaterial,
      productionStrategy,
      brand: {
        organizationId: access.organizationId,
        brandId: data.brandId,
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
      // Research-only mode: manifest created and validated, zero production jobs submitted
      await sql`
        insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
        values (
          ${crypto.randomUUID()}, ${access.organizationId}, ${data.brandId}, ${context.userId},
          'studio.research_manifest_created', 'brief', ${data.briefId},
          ${JSON.stringify({ manifestId: manifest.creativeId, mode: manifest.mode, beats: manifest.beats.length, planId: creativePlan.id })}
        )
      `;
      return loadSession(sql, access.organizationId, data.brandId, access.role);
    }

    const usage = await sql<{ runs_today: number; running: number; brand_runs_today: number; brand_running: number }>`
      select
        count(*) filter (where created_at > now() - interval '1 day' and status in ('running', 'completed'))::int as runs_today,
        count(*) filter (where status = 'running')::int as running,
        count(*) filter (where brand_id = ${data.brandId} and created_at > now() - interval '1 day' and status in ('running', 'completed'))::int as brand_runs_today,
        count(*) filter (where brand_id = ${data.brandId} and status = 'running')::int as brand_running
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
          ${crypto.randomUUID()}, ${access.organizationId}, ${data.brandId}, ${context.userId},
          'generation.blocked', 'brand', ${data.brandId},
          ${JSON.stringify({ reason: blocked.reason, estimatedCostCents: blocked.estimatedCostCents })}
        )
      `;
      throw new Error(blocked.reason);
    }
    const runId = crypto.randomUUID();
    await sql`
      insert into generation_runs (
        id, organization_id, brand_id, opportunity_id, brief_id, prompt_version, image_provider, video_provider, status, created_by
      ) values (
        ${runId}, ${access.organizationId}, ${data.brandId}, ${asText(brief.opportunity_id) || null}, ${data.briefId},
        ${STUDIO_PROMPT_VERSION}, ${data.imageProvider}, ${data.videoProvider}, 'running', ${context.userId}
      )
    `;
    try {
    const { generateImageBytes } = await import("@/lib/meridian/providers/image-bytes.server");
    const basePrompt = {
      productName,
      angle: asText(brief.angle),
      hook: asText(brief.hook),
      audience: asText(brief.audience),
      constraints: asText(brief.constraints),
    };

    const imageDeliverables = creativePlan.deliverables.filter(
      (d) => d.kind === "image" || d.kind === "carousel_slide"
    );
    const videoDeliverables = creativePlan.deliverables.filter(
      (d) => d.kind === "video"
    );

    for (let index = 0; data.imageProvider !== "none" && index < imageDeliverables.length; index += 1) {
      const prompt = variantPrompt({ ...basePrompt, index, kind: "image" });
      const creativeId = crypto.randomUUID();
      const assetId = crypto.randomUUID();
      const image = await generateImageBytes({
        provider: data.imageProvider,
        prompt,
        seed: `${runId}:image:${index}`,
        promptVersion: `${STUDIO_PROMPT_VERSION}#image-${index + 1}`,
        allowTest: data.imageProvider === "test:image",
      });
      if (image.status !== "ready") {
        await sql`
          insert into generation_jobs (
            id, organization_id, brand_id, brief_id, correlation_id, provider, model, prompt_id, prompt_version,
            status, error, created_by
          ) values (
            ${crypto.randomUUID()}, ${access.organizationId}, ${data.brandId}, ${data.briefId}, ${runId},
            ${image.provider}, '', 'studio_media', ${`${STUDIO_PROMPT_VERSION}#image-${index + 1}`},
            ${image.status}, ${image.error.slice(0, 500)}, ${context.userId}
          )
        `;
        break;
      }
      const key = `${access.organizationId}/${data.brandId}/runs/${runId}/${assetId}.img`;
      const stored = await storeBlob(sql, {
        organizationId: access.organizationId,
        brandId: data.brandId,
        key,
        mime: image.mediaType,
        bytes: image.bytes,
      });
      const copy = `${productName}. ${prompt}`;
      const visual = await visualFacts(sql, access.organizationId, data.brandId, image.bytes);
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
        angle: asText(brief.angle),
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
        brandId: data.brandId,
        creativeId,
        facts,
      });
      const status = judged.rollup === "REJECT" ? "rejected" : judged.rollup === "AUTO_APPROVE" ? "approved" : "in_review";
      await sql`
        insert into creative_records (
          id, organization_id, brand_id, origin, title, raw_text, product_name, hook, hook_type, angle,
          message, cta, format, proof_type, opportunity_id, brief_id, status, created_by, workflow
        ) values (
          ${creativeId}, ${access.organizationId}, ${data.brandId}, 'generated', ${`${asText(brief.title)} image ${index + 1}`},
          ${copy}, ${productName}, ${asText(brief.hook)}, ${"demonstration"}, ${asText(brief.angle)},
          ${copy}, ${asText(brief.cta)}, ${asText(brief.format)}, ${asText(brief.proof_type)},
          ${asText(brief.opportunity_id) || null}, ${data.briefId}, ${status}, ${context.userId},
          ${JSON.stringify({ generationRunId: runId, jevDecisionId: asText(brief.decision_id), provider: image.provider, model: image.model, promptVersion: image.promptVersion, kind: "image", variant: index + 1 })}
        )
      `;
      await sql`
        insert into assets (
          id, organization_id, brand_id, creative_id, version, storage_key, content_hash, mime_type, source, status,
          lifecycle, checksum, width, height, byte_size, provider, model, prompt_version, generation_run_id, kind,
          qa_decision, review_status, media_status, variant_index, provenance
        ) values (
          ${assetId}, ${access.organizationId}, ${data.brandId}, ${creativeId}, 1, ${key}, ${stored.checksum},
          ${image.mediaType}, ${image.provider}, 'stored', 'qa_required', ${stored.checksum}, ${image.width}, ${image.height},
          ${stored.byteSize}, ${image.provider}, ${image.model}, ${image.promptVersion}, ${runId}, 'image',
          ${judged.rollup}, ${status}, 'completed', ${index}, 'generated'
        )
      `;
      if (status === "in_review") {
        await sql`
          insert into reviews (id, organization_id, brand_id, decision_id, creative_id, subject_label)
          values (${crypto.randomUUID()}, ${access.organizationId}, ${data.brandId}, ${judged.decisionId}, ${creativeId}, ${`Image ${index + 1}`})
        `;
      }
      await sql`
        insert into generation_jobs (
          id, organization_id, brand_id, brief_id, correlation_id, provider, model, prompt_id, prompt_version,
          status, output, creative_id, created_by
        ) values (
          ${crypto.randomUUID()}, ${access.organizationId}, ${data.brandId}, ${data.briefId}, ${runId},
          ${image.provider}, ${image.model}, 'studio_media', ${image.promptVersion}, 'completed',
          ${prompt.slice(0, 2000)}, ${creativeId}, ${context.userId}
        )
      `;
    }
    if (videoDeliverables.length > 0 && data.videoProvider && data.videoProvider !== "none") {
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
        where id = ${asText(brief.decision_id)} and organization_id = ${access.organizationId} and brand_id = ${data.brandId}
        limit 1
      `;
      const decisionRow = decisionRows[0];
      if (!decisionRow) throw new Error("JEV has not approved this creative. No video job was created.");
      const _decisionValue = decisionRow.decision === "AUTO_APPROVE" || decisionRow.decision === "HUMAN_REVIEW" || decisionRow.decision === "REJECT"
        ? decisionRow.decision
        : "HUMAN_REVIEW";

      const creativeSpec: CreativeSpec = {
        id: manifest.creativeId,
        organizationId: access.organizationId,
        brandId: data.brandId,
        title: asText(brief.title),
        format: asText(brief.format) || (mode === "video" ? "ugc" : mode),
        aspectRatio: manifest.format.aspectRatio === "4:5" ? "1:1" : manifest.format.aspectRatio,
        durationTargetSeconds: manifest.format.targetDurationSeconds ?? 8,
        hookLine: asText(brief.hook),
        script: `${asText(brief.hook)}\n${asText(brief.message)}\n${asText(brief.cta)}`,
        scenes: manifest.beats.map((b, i) => ({
          index: i,
          description: b.visualInstruction,
          durationSeconds: b.targetDurationSeconds ?? 2,
          onScreenText: b.onScreenText,
          voiceoverText: b.scriptOrCaption,
        })),
      };

      const provider = await productionRouter.route(
        creativeSpec,
        "BALANCED",
        data.videoProvider === "auto" ? undefined : data.videoProvider,
      );

      const submittedJob = await provider.submitJob(creativeSpec);
      if (submittedJob.status === "FAILED" || submittedJob.status === "PREFLIGHT_FAILED" || submittedJob.status === "NOT_CONFIGURED") {
        throw new Error(`Video production failed (${submittedJob.status}): ${submittedJob.error || "Provider rejected job."}`);
      }

      const prodJobId = submittedJob.meridianJobId || submittedJob.jobId || crypto.randomUUID();
      await sql`
        insert into production_jobs (
          id, organization_id, brand_id, provider, provider_job_id,
          request_id, status_url, cancel_url, status, cost_mode,
          estimated_cost_cents, input, created_at, submitted_at
        ) values (
          ${prodJobId}, ${access.organizationId}, ${data.brandId}, ${provider.id},
          ${submittedJob.providerJobId || submittedJob.jobId || null},
          ${submittedJob.requestId || null}, ${submittedJob.statusUrl || null}, ${submittedJob.cancelUrl || null},
          ${submittedJob.status}, 'BALANCED',
          ${Math.round(submittedJob.costEstimateUsd * 100)},
          ${JSON.stringify({ creativeSpec, runId, briefId: data.briefId, manifestId: manifest.creativeId, manifest })},
          now(), now()
        )
        on conflict (id) do update set
          status = excluded.status,
          provider_job_id = excluded.provider_job_id,
          updated_at = now()
      `;

      // If provider completed synchronously, finalize durable artifact immediately (P0.4)
      if (submittedJob.status === "COMPLETED" || submittedJob.status === "RENDERED") {
        await finalizeProductionArtifact(sql, {
          jobId: prodJobId,
          organizationId: access.organizationId,
          brandId: data.brandId,
          provider: provider.id,
          providerJobId: submittedJob.providerJobId || submittedJob.jobId,
          runId,
          rawArtifact: {
            uri: submittedJob.outputArtifactId,
            base64: (submittedJob.metadata?.videoBytesBase64 as string) || undefined,
            mimeType: (submittedJob.metadata?.mimeType as string) || "video/mp4",
          },
          options: {
            durationMs: (creativeSpec.durationTargetSeconds ?? 8) * 1000,
            job: submittedJob,
          },
        });
      }

      const videoCreativeId = crypto.randomUUID();
      const videoAssetId = crypto.randomUUID();
      const videoCopy = `${productName}. ${asText(brief.hook)}`;
      const storageKey = `${access.organizationId}/${data.brandId}/runs/${runId}/${videoAssetId}.mp4`;

      await sql`
        insert into creative_records (
          id, organization_id, brand_id, origin, title, raw_text, product_name, hook, hook_type, angle,
          message, cta, format, proof_type, opportunity_id, brief_id, status, created_by, workflow
        ) values (
          ${videoCreativeId}, ${access.organizationId}, ${data.brandId}, 'generated', ${`${asText(brief.title)} video`},
          ${videoCopy}, ${productName}, ${asText(brief.hook)}, ${"problem"}, ${asText(brief.angle)},
          ${videoCopy}, ${asText(brief.cta)}, ${asText(brief.format)}, ${asText(brief.proof_type)},
          ${asText(brief.opportunity_id) || null}, ${data.briefId}, 'in_review', ${context.userId},
          ${JSON.stringify({
            generationRunId: runId,
            provider: provider.id,
            providerJobId: submittedJob.jobId,
            productionJobId: prodJobId,
            jevDecisionId: asText(brief.decision_id),
            kind: "video",
          })}
        )
      `;

      await sql`
        insert into assets (
          id, organization_id, brand_id, creative_id, version, storage_key, content_hash, mime_type, source, status,
          lifecycle, checksum, width, height, byte_size, duration_ms, provider, model, prompt_version, generation_run_id,
          kind, qa_decision, review_status, media_status, variant_index, provenance
        ) values (
          ${videoAssetId}, ${access.organizationId}, ${data.brandId}, ${videoCreativeId}, 1, ${storageKey}, ${""},
          'video/mp4', ${provider.id}, 'stored', 'qa_required', ${""}, 1080, 1920,
          0, 8000, ${provider.id}, ${provider.id}, 'studio_video_v1', ${runId},
          'video', '', 'in_review', ${submittedJob.status === "RENDERED" || submittedJob.status === "COMPLETED" ? "completed" : "submitted"}, 0, 'generated'
        )
      `;
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
        mime: asText(video.mime_type) || "video/mp4",
        width: video.width == null ? null : asNumber(video.width),
        height: video.height == null ? null : asNumber(video.height),
        byteSize: asNumber(video.byte_size),
        destinationUrl: "",
      });
      const visual = await measuredVideoFrames(sql, access.organizationId, data.brandId, asText(video.storage_key));
      const facts = factsFor(loaded, {
        kind: "video",
        productName,
        angle: asText(video.angle),
        copy,
        prompt: copy,
        mime: asText(video.mime_type) || "video/mp4",
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
        brandId: data.brandId,
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
          values (${crypto.randomUUID()}, ${access.organizationId}, ${data.brandId}, ${judged.decisionId}, ${asText(video.creative_id)}, 'Video')
        `;
      }
    }
    }
    await sql`update briefs set status = 'used' where id = ${data.briefId}`;
    await sql`update generation_runs set status = 'completed' where id = ${runId}`;
    return loadSession(sql, access.organizationId, data.brandId, access.role);
    } catch (error) {
      await sql`
        update generation_runs set status = 'failed'
        where id = ${runId} and organization_id = ${access.organizationId} and status = 'running'
      `;
      throw error;
    }
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
