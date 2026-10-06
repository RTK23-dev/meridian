import { getSql } from "@/lib/db";
import { assertRole, isRole, type Role } from "@/lib/meridian/access";
import { buildBrief } from "@/lib/meridian/brief/engine";
import { loadBrandContext } from "@/lib/meridian/context/load";
import type { Sql } from "@/lib/meridian/learning/store";
import { applyLearnedPatterns } from "@/lib/meridian/learning/store";
import { fingerprintCreative } from "@/lib/meridian/intelligence/fingerprint";
import { findWhitespace } from "@/lib/meridian/intelligence/whitespace";
import { hypothesisById } from "@/lib/meridian/opportunity/catalog";
import { rankOpportunities, type OpportunityDraft } from "@/lib/meridian/opportunity/engine";
import { rerankBrand } from "@/lib/meridian/opportunity/rerank";
import { publishThrough } from "@/lib/meridian/providers/boundaries";
import { testProviderPerformance } from "@/lib/meridian/providers/test-provider";
import { claimAndRun } from "@/lib/meridian/jobs/sql-worker";
import { judgeBrief, judgeMedia, rollupDecision, type MediaFacts } from "./features";
import { STUDIO_PROMPT_VERSION, storeBlob, variantPrompt } from "./media-work";
import { ensureLocalSemantic, semanticNearest } from "../embeddings/store";

function clip(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
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
  const ranked = rankOpportunities({ organizationId, brandId, ...loaded });
  const discovered = ranked.filter((item) => item.source === "discovered");
  const top = discovered[0] ?? null;
  const exploration = ranked.find((item) => item.source === "prior") ?? null;
  const fingerprints = loaded.creatives.map((creative) => fingerprintCreative(creative, loaded.brain));
  let semantic: { note: string; clusters: { label: string; summary: string; competitorCount: number; ownCount: number }[] } = {
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
    semantic = {
      note: embedded.note,
      clusters: embedded.clusters.map((cluster) => ({
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
  const whitespace = findWhitespace({
    fingerprints,
    origins: loaded.creatives.map((creative) => ({ id: creative.id, origin: creative.origin })),
    brandText: `${loaded.brain.positioning} ${loaded.brain.valueProposition}`,
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
        select id, subject_id, question_id, decision, probability, confidence, reasons, evidence
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
    where brand_id = ${brandId} and organization_id = ${organizationId}
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
        }));
      const review = reviews.find((item) => asText(item.creative_id) === creativeId && asText(item.status) === "open");
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
        error: asText(row.error),
        questions,
      };
    }),
    learned: loaded.patterns.slice(0, 8).map((pattern) => ({
      summary: pattern.summary,
      lift: pattern.lift,
      attribute: pattern.attribute,
      value: pattern.value,
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
    const ranked = rankOpportunities({ organizationId: access.organizationId, brandId: data.brandId, ...loaded });
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
      const brief = buildBrief({
        opportunity: draft,
        brain: loaded.brain,
        patterns: loaded.patterns,
        rejections: loaded.rejections,
      });
      for (const pattern of loaded.patterns.filter((item) => item.lift < 0)) {
        const line = `Do not prefer ${pattern.attribute}=${pattern.value}.`;
        if (!brief.constraints.includes(line)) brief.constraints = `${brief.constraints}\n${line} ${pattern.summary}`.trim();
      }
      if (!brief.cta.trim()) brief.cta = "See it in use";
      brief.why.push("Success would test whether this direction beats this brand's stored baseline without copying a competitor line.");
      const briefId = crypto.randomUUID();
      const decisionId = crypto.randomUUID();
      const gate = judgeBrief({
        audience: brief.audience,
        hook: brief.hook,
        message: brief.message,
        format: brief.format,
        cta: brief.cta,
        angle: brief.angle,
      });
      if (gate.decision === "REJECT") {
        throw new Error("The brief gate rejected this. A person was not asked to ignore a stored rejection.");
      }
      await sql`
        insert into jev_decisions (
          id, organization_id, brand_id, correlation_id, question_id, question_version,
          subject_type, subject_id, input, evidence, probability, confidence, thresholds, decision, reasons
        ) values (
          ${decisionId}, ${access.organizationId}, ${data.brandId}, ${crypto.randomUUID()},
          ${gate.questionId}, ${gate.questionVersion}, 'brief', ${briefId}, ${JSON.stringify(gate.features)},
          ${JSON.stringify(gate.evidence)}, ${gate.probability}, ${gate.confidence}, ${JSON.stringify(gate.policy)},
          ${gate.decision}, ${JSON.stringify(gate.reasons)}
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
  const decisions = judgeMedia(input.facts);
  const rollup = rollupDecision(decisions);
  let pointed = "";
  for (const decision of decisions) {
    const id = crypto.randomUUID();
    if (!pointed && decision.decision === rollup) pointed = id;
    await sql`
      insert into jev_decisions (
        id, organization_id, brand_id, correlation_id, question_id, question_version, subject_type, subject_id,
        input, evidence, probability, confidence, thresholds, decision, reasons, provider, model
      ) values (
        ${id}, ${input.organizationId}, ${input.brandId}, ${input.creativeId}, ${decision.questionId},
        ${decision.questionVersion}, 'creative', ${input.creativeId}, ${JSON.stringify(decision.features)},
        ${JSON.stringify(decision.evidence)}, ${decision.probability}, ${decision.confidence},
        ${JSON.stringify(decision.policy)}, ${decision.decision}, ${JSON.stringify(decision.reasons)},
        'logistic-prior', ${decision.modelVersion}
      )
    `;
  }
  return { rollup, decisionId: pointed };
}

export async function generateStudioVariants(
  userId: string,
  data: { brandId: string; briefId: string; imageProvider: string; videoProvider: string },
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
    const runId = crypto.randomUUID();
    await sql`
      insert into generation_runs (
        id, organization_id, brand_id, opportunity_id, brief_id, prompt_version, image_provider, video_provider, status, created_by
      ) values (
        ${runId}, ${access.organizationId}, ${data.brandId}, ${asText(brief.opportunity_id) || null}, ${data.briefId},
        ${STUDIO_PROMPT_VERSION}, ${data.imageProvider}, ${data.videoProvider}, 'running', ${context.userId}
      )
    `;
    const { generateImageBytes } = await import("@/lib/meridian/providers/image-bytes.server");
    const productName = loaded.products[0]?.name || "";
    const basePrompt = {
      productName,
      angle: asText(brief.angle),
      hook: asText(brief.hook),
      audience: asText(brief.audience),
      constraints: asText(brief.constraints),
    };
    for (let index = 0; index < 3; index += 1) {
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
      if (image.status !== "ready") throw new Error(image.error);
      const key = `${access.organizationId}/${data.brandId}/runs/${runId}/${assetId}.img`;
      const stored = await storeBlob(sql, {
        organizationId: access.organizationId,
        brandId: data.brandId,
        key,
        mime: image.mediaType,
        bytes: image.bytes,
      });
      const copy = `${productName}. ${prompt}`;
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
        logoSimilarity: null,
        paletteDistance: null,
        semanticSimilarity: await semanticNearest(copy, competitorCopy(loaded)).catch(() => null),
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
          ${JSON.stringify({ generationRunId: runId, provider: image.provider, model: image.model, promptVersion: image.promptVersion, kind: "image", variant: index + 1 })}
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
    for (let index = 0; index < 3; index += 1) {
      const prompt = variantPrompt({ ...basePrompt, index, kind: "video" });
      const creativeId = crypto.randomUUID();
      const assetId = crypto.randomUUID();
      const mediaJobId = crypto.randomUUID();
      const copy = `${productName}. ${prompt}`;
      await sql`
        insert into creative_records (
          id, organization_id, brand_id, origin, title, raw_text, product_name, hook, hook_type, angle,
          message, cta, format, proof_type, opportunity_id, brief_id, status, created_by, workflow
        ) values (
          ${creativeId}, ${access.organizationId}, ${data.brandId}, 'generated', ${`${asText(brief.title)} video ${index + 1}`},
          ${copy}, ${productName}, ${asText(brief.hook)}, ${"demonstration"}, ${asText(brief.angle)},
          ${copy}, ${asText(brief.cta)}, ${asText(brief.format)}, ${asText(brief.proof_type)},
          ${asText(brief.opportunity_id) || null}, ${data.briefId}, 'in_review', ${context.userId},
          ${JSON.stringify({ generationRunId: runId, provider: data.videoProvider, promptVersion: `${STUDIO_PROMPT_VERSION}#video-${index + 1}`, kind: "video", variant: index + 1 })}
        )
      `;
      await sql`
        insert into assets (
          id, organization_id, brand_id, creative_id, version, storage_key, content_hash, mime_type, source, status,
          lifecycle, provider, model, prompt_version, generation_run_id, kind, qa_decision, review_status,
          media_status, variant_index, provenance
        ) values (
          ${assetId}, ${access.organizationId}, ${data.brandId}, ${creativeId}, 1, ${`pending/${assetId}`}, '',
          'video/mp4', ${data.videoProvider}, 'unavailable', 'requested', ${data.videoProvider}, 'test-video-v1',
          ${`${STUDIO_PROMPT_VERSION}#video-${index + 1}`}, ${runId}, 'video', '', 'in_review', 'queued', ${index}, 'generated'
        )
      `;
      await sql`
        insert into media_jobs (
          id, organization_id, brand_id, asset_id, creative_id, generation_run_id, provider, model, prompt, prompt_version, status
        ) values (
          ${mediaJobId}, ${access.organizationId}, ${data.brandId}, ${assetId}, ${creativeId}, ${runId},
          ${data.videoProvider}, 'test-video-v1', ${prompt}, ${`${STUDIO_PROMPT_VERSION}#video-${index + 1}`}, 'queued'
        )
      `;
      const jobId = crypto.randomUUID();
      await sql`
        insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, payload, max_attempts)
        values (
          ${jobId}, ${access.organizationId}, ${data.brandId}, 'video.generate', ${`video.generate:${mediaJobId}`},
          'queued', ${JSON.stringify({ mediaJobId, allowTest: true, organizationId: access.organizationId })}, 4
        )
      `;
    }
    for (let pass = 0; pass < 16; pass += 1) {
      const due = await sql<{ id: string }>`
        select id from jobs
        where organization_id = ${access.organizationId} and brand_id = ${data.brandId}
          and job_type in ('video.generate', 'video.poll') and status in ('queued', 'retry')
        order by created_at asc
        limit 4
      `;
      if (due.length === 0) break;
      for (const job of due) await claimAndRun(sql, job.id);
    }
    const videos = await sql<Record<string, unknown>>`
      select a.id, a.creative_id, a.media_status, a.byte_size, a.width, a.height, a.duration_ms, a.transcript,
             a.scenes, a.checksum, a.mime_type, a.prompt_version, c.raw_text, c.angle
      from assets a
      join creative_records c on c.id = a.creative_id
      where a.generation_run_id = ${runId} and a.kind = 'video' and a.organization_id = ${access.organizationId}
    `;
    for (const video of videos) {
      const scenes = asJson<{ summary: string }[]>(video.scenes, []);
      const copy = asText(video.raw_text);
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
        logoSimilarity: null,
        paletteDistance: null,
        semanticSimilarity: await semanticNearest(copy, competitorCopy(loaded)).catch(() => null),
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
    await sql`update briefs set status = 'used' where id = ${data.briefId}`;
    await sql`update generation_runs set status = 'completed' where id = ${runId}`;
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
    const existing = await sql<{ external_id: string }>`
      select external_id from provider_objects
      where organization_id = ${access.organizationId} and provider = 'test' and object_type = 'ad' and idempotency_key = ${data.creativeId}
      limit 1
    `;
    if (!existing[0]) {
      const result = publishThrough({ provider: "test", creativeId: data.creativeId, allowTestProvider: true });
      if (!result.externalId) throw new Error("The publisher did not return an id. Nothing was stored.");
      await sql`
        insert into provider_objects (
          id, organization_id, brand_id, provider, object_type, idempotency_key, external_id, status
        ) values (
          ${crypto.randomUUID()}, ${access.organizationId}, ${data.brandId}, 'test', 'ad', ${data.creativeId},
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
