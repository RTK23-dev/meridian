import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, type Sql } from "@/lib/db";
import { countRejections } from "@/lib/meridian/learning/engine";
import { applyLearnedPatterns } from "@/lib/meridian/learning/store";
import { designExperiment } from "@/lib/meridian/experiments/design";
import { manualPerformanceSchema } from "@/lib/meridian/schemas/performance";
import { storedProbability } from "../decisions/probability.ts";
import {
  id,
  asText,
  asNumber,
  asJson,
  clip,
  objectInput,
  requireBrand,
  audit,
  notify,
} from "../machine-shared";

/** One recorded decision for the learning screen. A probability or confidence that was never stored reads back as null. */
export function learningDecisionView(row: Record<string, unknown>) {
  return {
    id: asText(row.id),
    question: `${asText(row.question_id)}.${asText(row.question_version)}`,
    subject: asText(row.subject_type),
    decision: asText(row.decision),
    probability: storedProbability(row.probability),
    confidence: storedProbability(row.confidence),
    reasons: asJson<string[]>(row.reasons, []),
    createdAt: asText(row.created_at),
  };
}

export async function persistLearnedPatterns(sql: Sql, organizationId: string, brandId: string, actorId: string): Promise<number> {
  const patterns = await applyLearnedPatterns(sql, organizationId, brandId);
  await audit(sql, {
    organizationId,
    brandId,
    actorId,
    action: "learning.refreshed",
    objectType: "brand",
    objectId: brandId,
    metadata: { patterns: String(patterns) },
  });
  await notify(sql, organizationId, brandId, "learning.update", `${patterns} pattern(s) stored from stored performance.`);
  return patterns;
}

export const recordPerformance = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    const metrics = manualPerformanceSchema.parse({ ...body, reach: body.reach ?? 0, platform: body.platform ?? "" });
    return {
      brandId: clip(body.brandId, 80, "Brand", true),
      creativeId: clip(body.creativeId, 80, "Creative", true),
      ...metrics,
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    const creatives = await sql<{ id: string; status: string; origin: string; angle: string; product_name: string }>`
      select id, status, origin, angle, product_name from creative_records
      where id = ${data.creativeId} and brand_id = ${data.brandId} and organization_id = ${access.organizationId}
      limit 1
    `;
    const creative = creatives[0];
    if (!creative || creative.origin === "competitor") throw new Error("Performance can only be attached to this brand's creatives.");
    if (creative.status === "rejected") throw new Error("Rejected creatives are not tested.");
    let experimentId = "";
    const running = await sql<{ id: string }>`
      select id from experiments
      where creative_id = ${data.creativeId} and status = 'running' limit 1
    `;
    if (running[0]) {
      experimentId = running[0].id;
    } else {
      experimentId = id();
      const design = designExperiment({
        angle: creative.angle,
        productName: creative.product_name,
        audience: "",
      });
      await sql`
        insert into experiments (
          id, organization_id, brand_id, creative_id, hypothesis, status, created_by,
          audience, platform, success_metric, expected_learning
        ) values (
          ${experimentId}, ${access.organizationId}, ${data.brandId}, ${data.creativeId},
          ${design.hypothesis}, 'running', ${context.userId},
          ${design.audience}, ${data.platform}, ${design.successMetric}, ${design.expectedLearning}
        )
      `;
    }
    const observationId = id();
    await sql`
      insert into performance_observations (
        id, organization_id, brand_id, creative_id, experiment_id, platform, impressions, reach, clicks,
        conversions, spend_cents, revenue_cents, observed_on, source, created_by
      ) values (
        ${observationId}, ${access.organizationId}, ${data.brandId}, ${data.creativeId}, ${experimentId},
        ${data.platform}, ${data.impressions}, ${data.reach}, ${data.clicks}, ${data.conversions}, ${data.spendCents},
        ${data.revenueCents}, ${data.observedOn}, 'manual', ${context.userId}
      )
    `;
    if (creative.status === "approved" || creative.status === "generated") {
      await sql`update creative_records set status = 'testing', updated_at = now() where id = ${data.creativeId}`;
    }
    await audit(sql, {
      organizationId: access.organizationId,
      brandId: data.brandId,
      actorId: context.userId,
      action: "performance.recorded",
      objectType: "creative",
      objectId: data.creativeId,
      metadata: { impressions: String(data.impressions), clicks: String(data.clicks) },
    });
    await notify(sql, access.organizationId, data.brandId, "performance.recorded", "Stored a manual performance row. No ad account is connected.");
    const idempotencyKey = `performance.recorded:${observationId}`;
    const queued = await sql<{ id: string }>`
      select id from jobs
      where organization_id = ${access.organizationId}
        and idempotency_key = ${idempotencyKey}
        and status in ('queued', 'running', 'retry', 'succeeded')
      limit 1
    `;
    const learningJobId = id();
    if (!queued[0]) {
      await sql`
        insert into jobs (
          id, organization_id, brand_id, job_type, idempotency_key, status, payload
        ) values (
          ${learningJobId}, ${access.organizationId}, ${data.brandId}, 'learning.update', ${idempotencyKey},
          'queued', ${JSON.stringify({ observationId, creativeId: data.creativeId, organizationId: access.organizationId })}
        )
      `;
      await sql`
        insert into jobs (
          id, organization_id, brand_id, job_type, idempotency_key, status, payload, depends_on
        ) values (
          ${id()}, ${access.organizationId}, ${data.brandId}, 'opportunity.refresh', ${`opportunity.after:${observationId}`},
          'queued', ${JSON.stringify({ observationId, organizationId: access.organizationId })}, ${learningJobId}
        )
      `;
    }
    return { id: observationId };
  });

export const refreshLearning = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ brandId: clip(objectInput(input).brandId, 80, "Brand", true) }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    const patterns = await persistLearnedPatterns(sql, access.organizationId, data.brandId, context.userId);
    return { patterns };
  });

export const getLearning = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ brandId: clip(objectInput(input).brandId, 80, "Brand", true) }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "viewer");
    const patterns = await sql<Record<string, unknown>>`
      select id, attribute, value, metric, lift, sample_size, baseline, observed, impressions, summary, state, scope, created_at
      from learned_patterns
      where organization_id = ${access.organizationId}
        and (brand_id = ${data.brandId} or scope = 'organization')
      order by created_at desc
    `;
    const rejections = await sql<{ reason_code: string; count: number }>`
      select reason_code, count(*) as count from rejections
      where brand_id = ${data.brandId} and organization_id = ${access.organizationId}
      group by reason_code order by count desc
    `;
    const decisions = await sql<Record<string, unknown>>`
      select id, question_id, question_version, subject_type, decision, probability, confidence, reasons, created_at
      from jev_decisions
      where brand_id = ${data.brandId} and organization_id = ${access.organizationId}
      order by created_at desc limit 30
    `;
    const settingRows = await sql<Record<string, unknown>>`
      select use_organization_learning from brand_brains where brand_id = ${data.brandId} limit 1
    `;
    const flag = settingRows[0]?.use_organization_learning;
    return {
      role: access.role,
      organizationId: access.organizationId,
      useOrganizationLearning: flag === true || flag === "t" || flag === "true",
      policy: "A pattern is stored only after at least 3 creatives and 300 impressions in that bucket, and only when CTR, conversion rate, or ROAS differs from the brand baseline by 5% or more. Pairs such as angle+hook and visual style+format use the same floor. VALIDATED requires 4 creatives, 2000 impressions, and 15% absolute lift. OBSERVED patterns are discounted in the next rank. Organization patterns are ignored unless this brand opts in. Global patterns are never used. A separate worker runs queued learning when it is deployed. Thresholds change only after an admin approves a proposal.",
      patterns: patterns.map((row) => ({
        id: asText(row.id),
        attribute: asText(row.attribute),
        value: asText(row.value),
        metric: asText(row.metric),
        lift: asNumber(row.lift),
        sampleSize: asNumber(row.sample_size),
        baseline: asNumber(row.baseline),
        observed: asNumber(row.observed),
        impressions: asNumber(row.impressions),
        summary: asText(row.summary),
        state: asText(row.state) || "INFERRED",
        scope: asText(row.scope) || "brand",
      })),
      rejections: countRejections(rejections.flatMap((row) => Array.from({ length: asNumber(row.count) }, () => row.reason_code))),
      decisions: decisions.map(learningDecisionView),
    };
  });

export const setOrganizationLearning = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return { brandId: clip(body.brandId, 80, "Brand", true), enabled: body.enabled === true };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    await sql`
      update brand_brains set use_organization_learning = ${data.enabled}, updated_at = now(), updated_by = ${context.userId}
      where brand_id = ${data.brandId}
    `;
    await audit(sql, {
      organizationId: access.organizationId,
      brandId: data.brandId,
      actorId: context.userId,
      action: "learning.scope_updated",
      objectType: "brand",
      objectId: data.brandId,
      metadata: { useOrganizationLearning: data.enabled ? "true" : "false" },
    });
    return { useOrganizationLearning: data.enabled };
  });

export const sharePatternWithOrganization = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return {
      brandId: clip(body.brandId, 80, "Brand", true),
      patternId: clip(body.patternId, 80, "Pattern", true),
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "admin");
    const rows = await sql<Record<string, unknown>>`
      select attribute, value, metric, lift, sample_size, baseline, observed, impressions, summary, state, clicks, conversions, spend_cents, revenue_cents, scope
      from learned_patterns
      where id = ${data.patternId} and brand_id = ${data.brandId} and organization_id = ${access.organizationId}
      limit 1
    `;
    const row = rows[0];
    if (!row) throw new Error("That pattern is not in this brand.");
    if (asText(row.scope) === "organization") return { status: "already" as const };
    const existing = await sql<{ id: string }>`
      select id from learned_patterns
      where brand_id = ${data.brandId} and attribute = ${asText(row.attribute)} and value = ${asText(row.value)}
        and metric = ${asText(row.metric)} and scope = 'organization'
      limit 1
    `;
    if (existing[0]) return { status: "already" as const };
    await sql`
      insert into learned_patterns (
        id, organization_id, brand_id, attribute, value, metric, lift, sample_size, baseline, observed, impressions, summary,
        state, clicks, conversions, spend_cents, revenue_cents, scope
      ) values (
        ${id()}, ${access.organizationId}, ${data.brandId}, ${asText(row.attribute)}, ${asText(row.value)}, ${asText(row.metric)},
        ${asNumber(row.lift)}, ${asNumber(row.sample_size)}, ${asNumber(row.baseline)}, ${asNumber(row.observed)}, ${asNumber(row.impressions)},
        ${asText(row.summary)}, ${asText(row.state) || "INFERRED"}, ${asNumber(row.clicks)}, ${asNumber(row.conversions)},
        ${asNumber(row.spend_cents)}, ${asNumber(row.revenue_cents)}, 'organization'
      )
    `;
    return { status: "shared" as const };
  });
