import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, type Sql } from "@/lib/db";
import { buildBrief, renderGenerationPrompt, type BriefDraft } from "@/lib/meridian/brief/engine";
import { decideForTenant } from "@/lib/meridian/jev/engine";
import { briefGate, creativeQa, visualQa } from "@/lib/meridian/jev/questions";
import { loadQuestionPolicy } from "@/lib/meridian/jev/policy";
import { HYPOTHESES } from "@/lib/meridian/opportunity/catalog";
import { assessCopy } from "@/lib/meridian/production/assess";
import { promptById } from "@/lib/meridian/prompts/registry";
import { contentHash } from "@/lib/meridian/assets/lifecycle";
import { deriveMetrics } from "@/lib/meridian/performance/metrics";
import { selectContext } from "@/lib/meridian/retrieval/pack";
import { summarizeIntelligence } from "@/lib/meridian/intelligence/summary";
import { inspectImage } from "@/lib/meridian/assets/images";
import {
  id,
  asText,
  asNumber,
  asJson,
  clip,
  objectInput,
  requireBrand,
  audit,
  loadContext,
  insertDecision,
  ensurePromptRows,
  writeRelationships,
  notify,
} from "../machine-shared";
import { assertOpportunityClear, opportunityView } from "../opportunity/actions";
import { briefStatusFor, productionRefusalFor } from "@/lib/meridian/studio/brief-review.server";

function briefDraftFromRow(row: Record<string, unknown>): BriefDraft {
  return {
    title: asText(row.title),
    audience: asText(row.audience),
    angle: asText(row.angle),
    hook: asText(row.hook),
    message: asText(row.message),
    offer: asText(row.offer),
    cta: asText(row.cta),
    format: asText(row.format),
    proofType: asText(row.proof_type),
    constraints: asText(row.constraints),
    learningNotes: asJson<string[]>(row.learning_notes, []),
    failureNotes: asJson<string[]>(row.failure_notes, []),
    why: asJson<string[]>(row.why, []),
    workflow: asJson(row.workflow, { templateId: "", templateVersion: "", label: "", stages: [], variables: {} }),
    context: asJson(row.context_pack, {
      brandPositioning: "",
      prohibitedClaims: "",
      wordsToAvoid: "",
      requiredDisclaimers: "",
      patterns: [],
      failures: [],
      opportunityReason: "",
      untrustedObservations: [],
    }),
  };
}

async function produceCreative(
  sql: Sql,
  input: {
    userId: string;
    organizationId: string;
    brandId: string;
    briefId: string;
    hook: string;
    script: string;
    offer: string;
    cta: string;
    visualTreatment: string;
    claims: string[];
    provider: string;
    model: string;
    modelResponse: string;
    jobStatus: string;
  },
): Promise<{ creativeId: string; decision: string; reasons: string[] }> {
  const briefs = await sql<Record<string, unknown>>`
    select * from briefs
    where id = ${input.briefId} and brand_id = ${input.brandId} and organization_id = ${input.organizationId}
    limit 1
  `;
  const briefRow = briefs[0];
  if (!briefRow) throw new Error("Brief not found.");
  const productionRefusal = productionRefusalFor(asText(briefRow.status));
  if (productionRefusal) throw new Error(productionRefusal);
  const opportunityId = asText(briefRow.opportunity_id);
  if (opportunityId) await assertOpportunityClear(sql, opportunityId);
  const loaded = await loadContext(sql, input.organizationId, input.brandId);
  const workflow = asJson<BriefDraft["workflow"]>(briefRow.workflow, {
    templateId: "",
    templateVersion: "",
    label: "",
    stages: [],
    variables: {},
  });
  const productName = workflow.variables?.product?.trim() || "";
  const product = loaded.products.find((item) => item.name === productName) ?? null;
  const angle = asText(briefRow.angle);
  let hookType = HYPOTHESES.find((item) => item.angle === angle)?.hookType ?? "unspecified";
  if (opportunityId) {
    const hooks = await sql<{ hook_type: string }>`
      select hook_type from opportunities
      where id = ${opportunityId} and brand_id = ${input.brandId} and organization_id = ${input.organizationId}
      limit 1
    `;
    const stored = hooks[0]?.hook_type?.trim();
    if (stored) hookType = stored;
  }
  const text = [input.hook, input.script, input.offer, input.cta, ...input.claims].join("\n");
  const assessed = assessCopy({
    text,
    productName: product?.name || productName,
    allowedClaims: product?.allowedClaims || "",
    prohibitedClaims: [loaded.brain.prohibitedClaims, product?.prohibitedClaims || ""].filter(Boolean).join("\n"),
    requiredDisclaimers: loaded.brain.requiredDisclaimers,
    wordsToAvoid: loaded.brain.wordsToAvoid,
    hook: input.hook,
    cta: input.cta,
  });
  const textPolicy = await loadQuestionPolicy(sql, input.organizationId, creativeQa);
  const decision = decideForTenant(textPolicy.question, assessed.evidence, {
    organizationId: input.organizationId,
    brandId: input.brandId,
    evidence: loaded.creatives,
  }, {
    policyVersion: textPolicy.policy.policyVersion,
    calibration: textPolicy.policy.calibration,
    provider: input.provider || "jev",
    model: input.model || "creative-qa",
  });
  const creativeId = id();
  const decisionId = id();
  const correlationId = id();
  workflow.variables = {
    ...(workflow.variables ?? {}),
    hook: input.hook,
    script: input.script,
    offer: input.offer,
    cta: input.cta,
    visualTreatment: input.visualTreatment,
  };
  await insertDecision(sql, {
    id: decisionId,
    organizationId: input.organizationId,
    brandId: input.brandId,
    correlationId,
    questionId: decision.questionId,
    questionVersion: decision.questionVersion,
    subjectType: "creative",
    subjectId: creativeId,
    input: assessed.evidence,
    evidence: decision.evidence,
    probability: decision.probability,
    confidence: decision.confidence,
    thresholds: decision.thresholds,
    decision: decision.decision,
    reasons: decision.reasons,
    provider: input.provider,
    model: input.model,
    modelResponse: input.modelResponse,
    answer: decision.answer,
    schemaVersion: decision.schemaVersion,
    policyVersion: decision.policyVersion,
    calibrationVersion: decision.calibrationVersion,
  });
  const status = decision.decision === "AUTO_APPROVE"
    ? "approved"
    : decision.decision === "HUMAN_REVIEW"
      ? "in_review"
      : "rejected";
  await sql`
    insert into creative_records (
      id, organization_id, brand_id, origin, title, raw_text, product_name, hook, hook_type, angle,
      message, offer, cta, format, visual_style, proof_type, claim, template_key, workflow,
      opportunity_id, brief_id, status, created_by
    ) values (
      ${creativeId}, ${input.organizationId}, ${input.brandId}, 'generated', ${asText(briefRow.title)},
      ${input.script}, ${product?.name || productName}, ${input.hook}, ${hookType},
      ${angle}, ${input.script}, ${input.offer}, ${input.cta}, ${asText(briefRow.format)},
      ${input.visualTreatment}, ${asText(briefRow.proof_type)}, ${input.claims.join("; ")},
      ${workflow.templateId}, ${JSON.stringify(workflow)},
      ${opportunityId || null}, ${input.briefId}, ${status}, ${input.userId}
    )
  `;
  await writeRelationships(sql, input.organizationId, input.brandId, creativeId, {
    angle,
    hookType,
    format: asText(briefRow.format),
    proofType: asText(briefRow.proof_type),
    productName: product?.name || productName,
  });
  if (decision.decision === "HUMAN_REVIEW") {
    await sql`
      insert into reviews (id, organization_id, brand_id, decision_id, creative_id, subject_label)
      values (${id()}, ${input.organizationId}, ${input.brandId}, ${decisionId}, ${creativeId}, ${asText(briefRow.title)})
    `;
    await notify(sql, input.organizationId, input.brandId, "review.required", asText(briefRow.title));
  }
  if (decision.decision === "REJECT") {
    await sql`
      insert into rejections (id, organization_id, brand_id, creative_id, decision_id, reason_code, note, rejected_by)
      values (
        ${id()}, ${input.organizationId}, ${input.brandId}, ${creativeId}, ${decisionId},
        ${assessed.reasonCode || "other"}, ${decision.reasons.join(" ").slice(0, 500)}, ${"jev"}
      )
    `;
  }
  await sql`update briefs set status = 'used' where id = ${input.briefId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}`;
  await sql`
    insert into assets (
      id, organization_id, brand_id, creative_id, version, storage_key, content_hash, mime_type, source, status
    ) values (
      ${id()}, ${input.organizationId}, ${input.brandId}, ${creativeId}, 1,
      ${`creative/${creativeId}/v1.txt`}, ${contentHash(input.script)}, 'text/plain', 'composed_text', 'stored'
    )
  `;
  const prompt = promptById("creative_script");
  if (prompt && input.provider) {
    await ensurePromptRows(sql);
    await sql`
      insert into generation_jobs (
        id, organization_id, brand_id, brief_id, correlation_id, provider, model, prompt_id, prompt_version,
        status, output, creative_id, created_by
      ) values (
        ${id()}, ${input.organizationId}, ${input.brandId}, ${input.briefId}, ${correlationId},
        ${input.provider}, ${input.model}, ${prompt.id}, ${prompt.version}, ${input.jobStatus},
        ${input.modelResponse.slice(0, 8000)}, ${creativeId}, ${input.userId}
      )
    `;
  }
  return { creativeId, decision: decision.decision, reasons: decision.reasons };
}

export const createBriefFromOpportunity = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return { brandId: clip(body.brandId, 80, "Brand", true), opportunityId: clip(body.opportunityId, 80, "Opportunity", true) };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    const rows = await sql<Record<string, unknown>>`
      select * from opportunities
      where id = ${data.opportunityId} and brand_id = ${data.brandId} and organization_id = ${access.organizationId}
      limit 1
    `;
    const row = rows[0];
    if (!row) throw new Error("Opportunity not found.");
    if (asText(row.status) === "rejected" || asText(row.status) === "dismissed") {
      throw new Error("This opportunity was rejected or dismissed.");
    }
    await assertOpportunityClear(sql, data.opportunityId);
    const existing = await sql<{ id: string }>`
      select id from briefs
      where opportunity_id = ${data.opportunityId} and status = 'ready'
      order by created_at desc limit 1
    `;
    if (existing[0]) return { id: existing[0].id };
    const loaded = await loadContext(sql, access.organizationId, data.brandId);
    const draft = opportunityView(row, "", 0);
    const sameAngle = loaded.creatives
      .filter((creative) => creative.origin === "competitor" && creative.angle === draft.angle && creative.text)
      .slice(0, 4)
      .map((creative) => ({ id: creative.id, text: creative.text }));
    const retrieved = selectContext(
      `${draft.angle} ${draft.hookDirection}`,
      loaded.creatives
        .filter((creative) => creative.origin === "competitor")
        .map((creative) => ({ id: creative.id, brandId: creative.brandId, text: creative.text })),
      data.brandId,
    );
    const observations = (retrieved.length > 0 ? retrieved : sameAngle).map((item) => ({ id: item.id, text: item.text }));
    const brief = buildBrief({
      opportunity: draft,
      brain: loaded.brain,
      patterns: loaded.patterns,
      rejections: loaded.rejections,
      observations,
    });
    const briefPolicy = await loadQuestionPolicy(sql, access.organizationId, briefGate);
    const gate = decideForTenant(briefPolicy.question, {
      hasAudience: brief.audience.trim().length > 1,
      hasProduct: brief.workflow.variables.product.trim().length > 1 || draft.productName.trim().length > 1,
      hasHook: brief.hook.trim().length > 1,
      hasAngle: brief.angle.trim().length > 1,
      hasCta: brief.cta.trim().length > 1,
      hasFormat: brief.format.trim().length > 1,
    }, {
      organizationId: access.organizationId,
      brandId: data.brandId,
      evidence: loaded.creatives,
    }, {
      policyVersion: briefPolicy.policy.policyVersion,
      calibration: briefPolicy.policy.calibration,
      provider: "jev",
      model: "brief-gate",
    });
    const briefId = id();
    const decisionId = id();
    const correlationId = id();
    await insertDecision(sql, {
      id: decisionId,
      organizationId: access.organizationId,
      brandId: data.brandId,
      correlationId,
      questionId: gate.questionId,
      questionVersion: gate.questionVersion,
      subjectType: "brief",
      subjectId: briefId,
      input: { title: brief.title, angle: brief.angle, format: brief.format },
      evidence: gate.evidence,
      probability: gate.probability,
      confidence: gate.confidence,
      thresholds: gate.thresholds,
      decision: gate.decision,
      reasons: gate.reasons,
      provider: gate.provider,
      model: gate.model,
      answer: gate.answer,
      schemaVersion: gate.schemaVersion,
      policyVersion: gate.policyVersion,
      calibrationVersion: gate.calibrationVersion,
    });
    await sql`
      insert into briefs (
        id, organization_id, brand_id, opportunity_id, title, audience, angle, hook, message, offer, cta,
        format, proof_type, constraints, context_pack, workflow, why, learning_notes, failure_notes,
        status, decision_id, created_by
      ) values (
        ${briefId}, ${access.organizationId}, ${data.brandId}, ${data.opportunityId}, ${brief.title},
        ${brief.audience}, ${brief.angle}, ${brief.hook}, ${brief.message}, ${brief.offer}, ${brief.cta},
        ${brief.format}, ${brief.proofType}, ${brief.constraints}, ${JSON.stringify(brief.context)},
        ${JSON.stringify(brief.workflow)}, ${JSON.stringify(brief.why)}, ${JSON.stringify(brief.learningNotes)},
        ${JSON.stringify(brief.failureNotes)}, ${briefStatusFor(gate.decision)},
        ${decisionId}, ${context.userId}
      )
    `;
    if (gate.decision !== "REJECT") {
      await sql`update opportunities set status = 'briefed' where id = ${data.opportunityId}`;
    }
    return { id: briefId, decision: gate.decision };
  });

export const composeCreative = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return {
      brandId: clip(body.brandId, 80, "Brand", true),
      briefId: clip(body.briefId, 80, "Brief", true),
      hook: clip(body.hook, 400, "Hook", true),
      script: clip(body.script, 4000, "Script", true),
      offer: clip(body.offer, 400, "Offer"),
      cta: clip(body.cta, 240, "Call to action", true),
      visualTreatment: clip(body.visualTreatment, 400, "Visual treatment"),
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    return produceCreative(sql, {
      userId: context.userId,
      organizationId: access.organizationId,
      brandId: data.brandId,
      briefId: data.briefId,
      hook: data.hook,
      script: data.script,
      offer: data.offer,
      cta: data.cta,
      visualTreatment: data.visualTreatment,
      claims: [],
      provider: "",
      model: "",
      modelResponse: "",
      jobStatus: "human",
    });
  });

export const generateCreative = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return { brandId: clip(body.brandId, 80, "Brand", true), briefId: clip(body.briefId, 80, "Brief", true) };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    const briefs = await sql<Record<string, unknown>>`
      select * from briefs where id = ${data.briefId} and brand_id = ${data.brandId} and organization_id = ${access.organizationId} limit 1
    `;
    const briefRow = briefs[0];
    if (!briefRow) throw new Error("Brief not found.");
    const prompt = promptById("creative_script");
    if (!prompt) throw new Error("Creative prompt is not active.");
    const { activeChatProvider, extractJson, providerStatus } = await import("@/lib/meridian/providers/chat.server");
    const provider = activeChatProvider();
    const status = providerStatus();
    if (!provider) return { status: "unavailable" as const, message: "No text model is configured. You can still write the script yourself." };
    const brief = briefDraftFromRow(briefRow);
    const rendered = renderGenerationPrompt(brief);
    const result = await provider.complete({
      model: status.model,
      temperature: prompt.temperature,
      maxTokens: 900,
      system: rendered.system,
      user: rendered.user,
    });
    const correlationId = id();
    await ensurePromptRows(sql);
    await sql`
      insert into model_runs (
        id, organization_id, brand_id, correlation_id, operation, provider, model, prompt_id, prompt_version,
        input_ref, output, latency_ms, tokens, status, error
      ) values (
        ${id()}, ${access.organizationId}, ${data.brandId}, ${correlationId}, 'creative_script',
        ${result.ok ? result.provider : provider.id}, ${status.model}, ${prompt.id}, ${prompt.version},
        ${data.briefId}, ${result.ok ? result.content.slice(0, 8000) : ""}, ${result.ok ? result.latencyMs : 0},
        ${result.ok ? result.tokens : null}, ${result.ok ? "completed" : result.status}, ${result.ok ? "" : result.error}
      )
    `;
    if (!result.ok) return { status: "failed" as const, message: result.error };
    let copy: { hook: string; script: string; offer: string; cta: string; visualTreatment: string; claims: string[] };
    try {
      const parsed = extractJson(result.content) as Record<string, unknown>;
      copy = {
        hook: clip(parsed.hook, 400, "Hook", true),
        script: clip(parsed.script, 4000, "Script", true),
        offer: clip(parsed.offer, 400, "Offer"),
        cta: clip(parsed.cta, 240, "Call to action", true),
        visualTreatment: clip(parsed.visualTreatment, 400, "Visual treatment"),
        claims: Array.isArray(parsed.claims) ? parsed.claims.filter((item) => typeof item === "string").map((item) => item.trim()).slice(0, 8) : [],
      };
    } catch (error) {
      return { status: "failed" as const, message: error instanceof Error ? error.message : "The model output was not usable." };
    }
    const produced = await produceCreative(sql, {
      userId: context.userId,
      organizationId: access.organizationId,
      brandId: data.brandId,
      briefId: data.briefId,
      ...copy,
      provider: result.provider,
      model: result.model,
      modelResponse: result.content,
      jobStatus: "completed",
    });
    return { status: "completed" as const, ...produced };
  });

export const listLibrary = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ brandId: clip(objectInput(input).brandId, 80, "Brand", true) }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "viewer");
    const rows = await sql<Record<string, unknown>>`
      select id, title, origin, angle, hook, status, asset_url, brief_id, opportunity_id, created_at
      from creative_records
      where brand_id = ${data.brandId} and organization_id = ${access.organizationId} and origin <> 'competitor'
      order by created_at desc limit 50
    `;
    const briefs = await sql<Record<string, unknown>>`
      select id, title, angle, status, opportunity_id, why, learning_notes, failure_notes, constraints, hook
      from briefs where brand_id = ${data.brandId} and organization_id = ${access.organizationId}
      order by created_at desc limit 20
    `;
    return {
      role: access.role,
      creatives: rows.map((row) => ({
        id: asText(row.id),
        title: asText(row.title),
        origin: asText(row.origin),
        angle: asText(row.angle),
        hook: asText(row.hook),
        status: asText(row.status),
        assetUrl: asText(row.asset_url),
        briefId: asText(row.brief_id),
        opportunityId: asText(row.opportunity_id),
        createdAt: asText(row.created_at),
      })),
      briefs: briefs.map((row) => ({
        id: asText(row.id),
        title: asText(row.title),
        angle: asText(row.angle),
        status: asText(row.status),
        opportunityId: asText(row.opportunity_id),
        hook: asText(row.hook),
        why: asJson<string[]>(row.why, []),
        learningNotes: asJson<string[]>(row.learning_notes, []),
        failureNotes: asJson<string[]>(row.failure_notes, []),
        constraints: asText(row.constraints),
      })),
    };
  });

export const getTrace = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return { brandId: clip(body.brandId, 80, "Brand", true), creativeId: clip(body.creativeId, 80, "Creative", true) };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "viewer");
    const creatives = await sql<Record<string, unknown>>`
      select * from creative_records
      where id = ${data.creativeId} and brand_id = ${data.brandId} and organization_id = ${access.organizationId}
      limit 1
    `;
    const creative = creatives[0];
    if (!creative) throw new Error("Creative not found.");
    const opportunityId = asText(creative.opportunity_id);
    const briefId = asText(creative.brief_id);
    const opportunities = opportunityId
      ? await sql<Record<string, unknown>>`select * from opportunities where id = ${opportunityId} and brand_id = ${data.brandId} limit 1`
      : [];
    const briefs = briefId
      ? await sql<Record<string, unknown>>`select id, title, why, learning_notes, failure_notes, status from briefs where id = ${briefId} limit 1`
      : [];
    const decisions = await sql<Record<string, unknown>>`
      select id, question_id, question_version, subject_type, decision, probability, confidence, reasons, created_at
      from jev_decisions
      where brand_id = ${data.brandId} and organization_id = ${access.organizationId}
        and subject_id in (${data.creativeId}, ${briefId || data.creativeId}, ${opportunityId || data.creativeId})
      order by created_at asc
    `;
    const observations = await sql<Record<string, unknown>>`
      select impressions, reach, clicks, conversions, spend_cents, revenue_cents, observed_on, source
      from performance_observations
      where creative_id = ${data.creativeId} and brand_id = ${data.brandId}
      order by observed_on desc
    `;
    const patterns = await sql<Record<string, unknown>>`
      select summary, attribute, value, lift from learned_patterns
      where brand_id = ${data.brandId} and organization_id = ${access.organizationId}
        and ((attribute = 'angle' and lower(value) = lower(${asText(creative.angle)}))
          or (attribute = 'hookType' and lower(value) = lower(${asText(creative.hook_type)})))
    `;
    return {
      creative: {
        id: asText(creative.id),
        title: asText(creative.title),
        status: asText(creative.status),
        angle: asText(creative.angle),
        hook: asText(creative.hook),
        script: asText(creative.raw_text),
        assetUrl: asText(creative.asset_url),
      },
      opportunity: opportunities[0]
        ? { id: asText(opportunities[0].id), reason: asText(opportunities[0].reason), label: asText(opportunities[0].label) }
        : null,
      brief: briefs[0]
        ? {
            id: asText(briefs[0].id),
            title: asText(briefs[0].title),
            status: asText(briefs[0].status),
            why: asJson<string[]>(briefs[0].why, []),
            learningNotes: asJson<string[]>(briefs[0].learning_notes, []),
            failureNotes: asJson<string[]>(briefs[0].failure_notes, []),
          }
        : null,
      decisions: decisions.map((row) => ({
        id: asText(row.id),
        question: `${asText(row.question_id)}.${asText(row.question_version)}`,
        subject: asText(row.subject_type),
        decision: asText(row.decision),
        probability: asNumber(row.probability),
        confidence: asNumber(row.confidence),
        reasons: asJson<string[]>(row.reasons, []),
        createdAt: asText(row.created_at),
      })),
      observations: observations.map((row) => {
        const totals = {
          impressions: asNumber(row.impressions),
          reach: asNumber(row.reach),
          clicks: asNumber(row.clicks),
          conversions: asNumber(row.conversions),
          spendCents: asNumber(row.spend_cents),
          revenueCents: asNumber(row.revenue_cents),
        };
        return {
          ...totals,
          ...deriveMetrics(totals),
          observedOn: asText(row.observed_on).slice(0, 10),
          source: asText(row.source),
        };
      }),
      patterns: patterns.map((row) => ({ summary: asText(row.summary), lift: asNumber(row.lift) })),
    };
  });

export const attachCreativeImage = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return { brandId: clip(body.brandId, 80, "Brand", true), creativeId: clip(body.creativeId, 80, "Creative", true) };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    const creatives = await sql<{ title: string; raw_text: string; hook: string; status: string; brief_id: string | null }>`
      select title, raw_text, hook, status, brief_id from creative_records
      where id = ${data.creativeId} and brand_id = ${data.brandId} and organization_id = ${access.organizationId}
        and origin <> 'competitor'
      limit 1
    `;
    const creative = creatives[0];
    if (!creative) throw new Error("Creative not found.");
    if (creative.status === "rejected") throw new Error("Rejected creatives are not illustrated.");
    const briefRows = creative.brief_id ? await sql<{ decision_id: string }>`
      select decision_id from briefs
      where id = ${creative.brief_id} and organization_id = ${access.organizationId} and brand_id = ${data.brandId}
      limit 1
    ` : [];
    const jevDecisionId = briefRows[0]?.decision_id ?? "";
    const { generateNanoBananaImage } = await import("@/lib/meridian/providers/nano-banana.server");
    const prompt = `Advertising still for ${creative.title}. ${creative.hook}. ${creative.raw_text}`.slice(0, 1800);
    const image = await generateNanoBananaImage({ prompt, promptVersion: "creative-image-v1" });
    if (image.status !== "ready") return { status: image.status, message: image.error };
    const assetId = id();
    const storageKey = `${access.organizationId}/${data.brandId}/creative/${data.creativeId}/${assetId}.png`;
    await sql`
      insert into asset_blobs (storage_key, organization_id, brand_id, body, mime_type, checksum, byte_size, version, lifecycle)
      values (${storageKey}, ${access.organizationId}, ${data.brandId}, ${Buffer.from(image.bytes).toString("base64")}, 'image/png', ${image.sha256}, ${image.bytes.byteLength}, 1, 'stored')
      on conflict (storage_key) do nothing
    `;
    await sql`
      insert into assets (
        id, organization_id, brand_id, creative_id, version, storage_key, content_hash, mime_type, source, status,
        lifecycle, checksum, width, height, byte_size, provider, model, prompt_version, kind, media_status, provenance
      ) values (
        ${assetId}, ${access.organizationId}, ${data.brandId}, ${data.creativeId}, 1, ${storageKey}, ${image.sha256},
        'image/png', 'google:nano-banana', 'stored', 'stored', ${image.sha256}, ${image.width}, ${image.height},
        ${image.bytes.byteLength}, ${image.provider}, ${image.model}, ${image.promptVersion}, 'image', 'completed', ${`jev-creative-image:${jevDecisionId || "no-decision"}`}
      )
    `;
    await sql`update creative_records set asset_url = ${storageKey}, updated_at = now() where id = ${data.creativeId} and organization_id = ${access.organizationId} and brand_id = ${data.brandId}`;
    const loaded = await loadContext(sql, access.organizationId, data.brandId);
    const product = loaded.products.find((item) => creative.raw_text.includes(item.name) || creative.title.includes(item.name)) ?? loaded.products[0];
    const { readCreativeImage } = await import("@/lib/meridian/providers/vision.server");
    const reading = await readCreativeImage({
      imageUrl: `data:image/png;base64,${Buffer.from(image.bytes).toString("base64")}`,
      productName: product?.name ?? "",
      allowedClaims: product?.allowedClaims ?? "",
      prohibitedClaims: [loaded.brain.prohibitedClaims, product?.prohibitedClaims ?? ""].filter(Boolean).join("\n"),
    });
    const visualInput = reading.ok
      ? reading.evidence
      : {
          available: false,
          logoPresent: null,
          logoMatchProbability: null,
          paletteMatch: null,
          productMatch: null,
          claimDetected: null,
          claimSupported: null,
          toneFit: null,
        };
    const visualPolicy = await loadQuestionPolicy(sql, access.organizationId, visualQa);
    const visual = decideForTenant(visualPolicy.question, visualInput, {
      organizationId: access.organizationId,
      brandId: data.brandId,
      evidence: loaded.creatives,
    }, {
      policyVersion: visualPolicy.policy.policyVersion,
      calibration: visualPolicy.policy.calibration,
      provider: reading.ok ? reading.provider : "jev",
      model: reading.ok ? reading.model : "visual-qa",
    });
    const decisionId = id();
    const correlationId = id();
    await insertDecision(sql, {
      id: decisionId,
      organizationId: access.organizationId,
      brandId: data.brandId,
      correlationId,
      questionId: visual.questionId,
      questionVersion: visual.questionVersion,
      subjectType: "creative_image",
      subjectId: data.creativeId,
      input: visualInput,
      evidence: visual.evidence,
      probability: visual.probability,
      confidence: visual.confidence,
      thresholds: visual.thresholds,
      decision: visual.decision,
      reasons: visual.reasons,
      provider: reading.ok ? reading.provider : visual.provider,
      model: reading.ok ? reading.model : visual.model,
      modelResponse: reading.ok ? reading.raw : "",
      answer: visual.answer,
      schemaVersion: visual.schemaVersion,
      policyVersion: visual.policyVersion,
      calibrationVersion: visual.calibrationVersion,
    });
    if (reading.ok) {
      const promptAsset = promptById("visual_evidence");
      if (promptAsset) {
        await ensurePromptRows(sql);
        await sql`
          insert into model_runs (
            id, organization_id, brand_id, correlation_id, operation, provider, model, prompt_id, prompt_version,
            input_ref, output, latency_ms, tokens, status, error
          ) values (
            ${id()}, ${access.organizationId}, ${data.brandId}, ${correlationId}, 'visual_evidence',
            ${reading.provider}, ${reading.model}, ${promptAsset.id}, ${promptAsset.version},
            ${data.creativeId}, ${reading.raw}, ${reading.latencyMs}, ${reading.tokens}, 'completed', ''
          )
        `;
      }
    }
    if (visual.decision === "HUMAN_REVIEW") {
      await sql`
        insert into reviews (id, organization_id, brand_id, decision_id, creative_id, subject_label)
        values (${id()}, ${access.organizationId}, ${data.brandId}, ${decisionId}, ${data.creativeId}, ${reading.ok ? "Image needs a person" : "Image has no vision check"})
      `;
    }
    if (visual.decision === "REJECT") {
      await sql`
        insert into rejections (id, organization_id, brand_id, creative_id, decision_id, reason_code, note, rejected_by)
        values (
          ${id()}, ${access.organizationId}, ${data.brandId}, ${data.creativeId}, ${decisionId},
          ${"visual_mismatch"}, ${visual.reasons.join(" ").slice(0, 500)}, ${"jev"}
        )
      `;
    }
    const message = reading.ok ? (visual.reasons[0] ?? "Vision evidence was scored.") : reading.error;
    return { status: "stored" as const, decision: visual.decision, message };
  });

export const getIntelligence = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ brandId: clip(objectInput(input).brandId, 80, "Brand", true) }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "viewer");
    const loaded = await loadContext(sql, access.organizationId, data.brandId);
    const summary = summarizeIntelligence(loaded.creatives);
    const { readSemanticClusters } = await import("@/lib/meridian/embeddings/store");
    let semanticNote = "local:semantic vectors were not read.";
    let semanticClusters: { label: string; summary: string }[] = [];
    try {
      const semantic = await readSemanticClusters(
        sql,
        access.organizationId,
        data.brandId,
        loaded.creatives.map((creative) => ({
          id: creative.id,
          origin: creative.origin,
          angle: creative.angle,
          text: creative.text,
        })),
      );
      semanticNote = semantic.note;
      semanticClusters = semantic.clusters.map((cluster) => ({ label: cluster.label, summary: cluster.summary }));
    } catch (error) {
      semanticNote = error instanceof Error ? error.message : "local:semantic could not be read.";
    }
    const notifications = await sql<Record<string, unknown>>`
      select kind, title, body, created_at from notifications
      where brand_id = ${data.brandId} and organization_id = ${access.organizationId}
        and not exists (
          select 1 from notification_preferences preference
          where preference.organization_id = ${access.organizationId}
            and preference.user_id = ${context.userId}
            and preference.kind = notifications.kind
            and preference.enabled = false
        )
      order by created_at desc limit 8
    `;
    return {
      role: access.role,
      ...summary,
      neuralEmbedding: "local:semantic" as const,
      semanticNote,
      semanticClusters,
      adLibrary: "NOT_CONNECTED" as const,
      publishing: "NOT_CONNECTED" as const,
      video: "NOT_CONNECTED" as const,
      performanceFeed: "NOT_CONNECTED" as const,
      notifications: notifications.map((row) => ({
        kind: asText(row.kind),
        title: asText(row.title),
        body: asText(row.body),
        createdAt: asText(row.created_at),
      })),
    };
  });

export const storeMaterial = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    const text = typeof body.text === "string" ? body.text.slice(0, 20_000) : "";
    const base64 = typeof body.base64 === "string" ? body.base64 : "";
    if (base64.length > 2_100_000) throw new Error("That file is too large.");
    return {
      brandId: clip(body.brandId, 80, "Brand", true),
      filename: clip(body.filename, 180, "File") || "pasted.txt",
      mime: clip(body.mime, 120, "Type") || "text/plain",
      text,
      base64,
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    const { parseMaterialDocument } = await import("@/lib/meridian/ingestion/materials");
    const parsed = await parseMaterialDocument({ filename: data.filename, mime: data.mime, text: data.text, base64: data.base64 });
    const documentId = id();
    if (parsed.status === "failed") {
      await sql`
        insert into source_documents (id, organization_id, brand_id, url, status, error, created_by)
        values (${documentId}, ${access.organizationId}, ${data.brandId}, ${`material:${data.filename}`}, 'failed', ${parsed.detail.slice(0, 400)}, ${context.userId})
      `;
      return { id: documentId, status: "failed" as const, detail: parsed.detail };
    }
    await sql`
      insert into source_documents (id, organization_id, brand_id, url, status, excerpt, created_by)
      values (${documentId}, ${access.organizationId}, ${data.brandId}, ${`material:${data.filename}`}, 'stored', ${parsed.text.slice(0, 12000)}, ${context.userId})
    `;
    return {
      id: documentId,
      status: "stored" as const,
      droppedLines: parsed.droppedLines,
      detail: "Text stored as untrusted source material. It is not in the brand brain until you accept a suggestion.",
    };
  });

export const uploadLogo = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    const base64 = typeof body.base64 === "string" ? body.base64 : "";
    if (!base64 || base64.length > 1_200_000) throw new Error("Choose a PNG, JPEG, or WEBP under 800 KB.");
    return { brandId: clip(body.brandId, 80, "Brand", true), base64 };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    const bytes = Buffer.from(data.base64, "base64");
    const inspected = inspectImage(bytes);
    if (!inspected.ok) return { status: "failed" as const, detail: inspected.detail };
    const assetId = id();
    const hash = contentHash(data.base64);
    await sql`
      insert into assets (id, organization_id, brand_id, version, storage_key, content_hash, mime_type, source, status, body, byte_size, label)
      values (
        ${assetId}, ${access.organizationId}, ${data.brandId}, 1, ${`brand/${data.brandId}/logo/${hash}`},
        ${hash}, ${inspected.mime}, 'logo_upload', 'stored', ${data.base64}, ${inspected.bytes}, 'logo'
      )
    `;
    await audit(sql, {
      organizationId: access.organizationId,
      brandId: data.brandId,
      actorId: context.userId,
      action: "asset.stored",
      objectType: "asset",
      objectId: assetId,
      metadata: { label: "logo", mime: inspected.mime },
    });
    return { status: "stored" as const, id: assetId, mime: inspected.mime, bytes: inspected.bytes };
  });

export const listBrandAssets = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ brandId: clip(objectInput(input).brandId, 80, "Brand", true) }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "viewer");
    const rows = await sql<Record<string, unknown>>`
      select id, mime_type, byte_size, label, body, created_at
      from assets
      where brand_id = ${data.brandId} and organization_id = ${access.organizationId} and label = 'logo' and status = 'stored'
      order by created_at desc limit 3
    `;
    return {
      logos: rows.map((row) => ({
        id: asText(row.id),
        mime: asText(row.mime_type),
        bytes: asNumber(row.byte_size),
        body: asText(row.body),
        createdAt: asText(row.created_at),
      })),
    };
  });
