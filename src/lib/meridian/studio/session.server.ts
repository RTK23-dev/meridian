import { getSql } from "../../db.ts";
import { loadBrandContext } from "../context/load.ts";
import { assertSameTenant } from "../domain.ts";
import type { Sql } from "../learning/store.ts";
import { isTestingRuntime } from "./media-work.ts";
import { CreativeDecisionEngine } from "../creative/engine.ts";
import type { CreationScope, AutonomyMode, CreativePlan } from "../creative/plan.ts";
import { markPlanAwaitingApproval, transitionCreativePlan } from "../creative/state-transition.server.ts";
import { creativeJudgmentsFromStoredDecision } from "./jev-context.ts";
import { resolveStudioRunPolicy } from "./run-policy.ts";
import { asText, requireBrand, studioBrandRunPolicy } from "./session-load.server.ts";
import { loadGatedJevDecision } from "./session-jev.server.ts";
import { executeApprovedCreativePlan } from "./session-execute.server.ts";

export { generationUsage, getStudioSession, loadSession, storedProbability, studioAutonomyDefault, studioBrandRunPolicy, type StudioSession } from "./session-load.server.ts";
export { writeJudgment } from "./image-qc.server.ts";
export { loadGatedJevDecision } from "./session-jev.server.ts";
export { executeApprovedCreativePlan } from "./session-execute.server.ts";
export { approveAndExecuteCreativePlan, rejectCreativePlan, reviewStudioVariant, publishStudioVariant, recordStudioTestPerformance } from "./session-review.server.ts";

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
    // The autonomy and the spend cap are checked against the brand's policy and the caller's role. A request cannot choose a more
    // automatic run or a larger cap than the brand allows (security review, finding 1).
    const brandPolicy = await studioBrandRunPolicy(sql, access.organizationId, data.brandId);
    const run = resolveStudioRunPolicy({
      role: access.role,
      requestedAutonomy: data.autonomy,
      brandAutonomy: brandPolicy.autonomy,
      ceilingUsd: brandPolicy.ceilingUsd,
      requestedMaxSpendUsd: data.maxSpendUsd,
    });
    if (!run.ok) throw new Error(run.problem);
    const autonomy: AutonomyMode = run.autonomy;
    const maxSpendUsd = run.maxSpendUsd;

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
        maxSpendUsd,
      },
    });

    // Persist CreativePlan in durable creative_plans table (P0-D, P1-B)
    await persistCreativePlanRow(sql, {
      plan: creativePlan,
      organizationId: access.organizationId,
      brandId: data.brandId,
      briefId: data.briefId,
      maxSpendUsd,
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
      // The row must say the plan waits for approval before the person can approve it. Approval is legal only from that state.
      await markPlanAwaitingApproval(sql, {
        organizationId: access.organizationId,
        brandId: data.brandId,
        planId: creativePlan.id,
        actorId: context.userId,
      });
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
