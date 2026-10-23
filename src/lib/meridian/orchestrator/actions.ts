// Server functions for the orchestrator's plans (owner direction 2026-10-20). Every one resolves the brand's organization, checks the
// caller's role (viewer to read, admin to change anything: plan, run, step edit and model changes are admin only), validates its input,
// and then calls the engine's orchestrator entry points.
// Without a connected OpenRouter key, anything that needs the live catalog says NOT_CONNECTED and calls nothing.

import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertRole, isRole, type Role } from "@/lib/meridian/access";
import { requireWorkspaceAdmin } from "@/lib/meridian/content-factory/service";
import { editPlanStepFor, planDraftFor, runPlanFor, textModelsFor } from "@/engine/orchestrator/api";
import type { NodeChange } from "@/engine/orchestrator/stale";
import { createPlanDraft, getPlan, listPlanEvents, listPlans, type StoredPlan } from "@/engine/orchestrator/store";
import { approvePlanBudget } from "@/engine/orchestrator/approval";
import { INITIAL_POLICY, readOrchestratorPolicy, writeOrchestratorPolicy } from "@/engine/orchestrator/policy-store";
import { getOrchestratorModel, isOrchestratorModelId, setOrchestratorModel } from "@/engine/orchestrator/settings";

const MODEL_ID = /^~?[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

function text(value: unknown, max: number, label: string, required = false): string {
  if (typeof value !== "string") {
    if (!required && (value === undefined || value === null)) return "";
    throw new Error(`${label} must be text.`);
  }
  const trimmed = value.trim();
  if (required && trimmed.length === 0) throw new Error(`${label} is required.`);
  if (trimmed.length > max) throw new Error(`${label} is too long.`);
  return trimmed;
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid request.");
  return input as Record<string, unknown>;
}

function number(value: unknown, label: string, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`${label} must be a number from ${min} to ${max}.`);
  return parsed;
}

/** A category budget the user may leave unset: absent, empty or null is unset, and the orchestrator splits that category. Otherwise a number in range. */
function optionalBudget(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return number(value, label, 0.01, 1000);
}

/** The brand's organization and the caller's role in it, checked against the minimum the action needs. */
async function requireBrand(userId: string, brandId: string, minimum: Role) {
  const sql = await getSql();
  const rows = await sql<{ organization_id: string; name: string }>`
    select organization_id, name from brands where id = ${brandId} and deleted_at is null limit 1
  `;
  const brand = rows[0];
  if (!brand) throw new Error("Brand not found.");
  const members = await sql<{ role: string }>`
    select role from memberships where user_id = ${userId} and organization_id = ${brand.organization_id} limit 1
  `;
  const role = members[0]?.role;
  if (!role || !isRole(role)) throw new Error("That workspace is not available to you.");
  assertRole(role, minimum);
  return { sql, organizationId: brand.organization_id, brandName: brand.name, now: () => new Date().toISOString() };
}

/** A plan as the screens show it: its status, its reasons and its steps, without the stored JSON strings. */
function summaryOf(plan: StoredPlan) {
  const estimate = plan.plan ? plan.plan.nodes.reduce((sum, node) => sum + (node.estimateUsd ?? 0), 0) : null;
  return {
    id: plan.id,
    title: plan.title,
    status: plan.status,
    orchestratorModel: plan.orchestratorModel,
    budgetUsd: plan.budgetUsd,
    estimateUsd: estimate,
    reasons: plan.reasons,
    catalogReadAt: plan.catalogReadAt,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    steps: plan.plan ? plan.plan.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      title: node.title,
      why: node.why,
      dependsOn: node.dependsOn,
      model: node.model ? node.model.id : null,
      params: node.params,
      estimateUsd: node.estimateUsd,
    })) : [],
  };
}

export const listOrchestratorPlans = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ brandId: text(objectInput(input).brandId, 80, "Brand", true) }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { sql, organizationId } = await requireBrand(context.userId, data.brandId, "viewer");
    const plans = await listPlans(sql, organizationId, 50);
    return { plans: plans.map(summaryOf) };
  });

export const getOrchestratorPlan = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return { brandId: text(body.brandId, 80, "Brand", true), planId: text(body.planId, 80, "Plan", true) };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { sql, organizationId } = await requireBrand(context.userId, data.brandId, "viewer");
    const plan = await getPlan(sql, organizationId, data.planId);
    if (plan === null) throw new Error("Plan not found.");
    const events = await listPlanEvents(sql, organizationId, data.planId, 0);
    return { plan: summaryOf(plan), events };
  });

/** The format of a brief made from the person's own inputs, when no format is given. The brief still states what is to be made. */
const OWN_INPUTS_FORMAT = "A short branded video made from the inputs below.";

export const createOrchestratorDraft = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    // Empty means the model stored in the Content Factory panel is used.
    const model = text(body.orchestratorModelId, 200, "Orchestrating model");
    if (model !== "" && !isOrchestratorModelId(model)) throw new Error("The orchestrating model must be an OpenRouter id, vendor/model.");
    return {
      brandId: text(body.brandId, 80, "Brand", true),
      title: text(body.title, 120, "Title", true),
      goal: text(body.goal, 2000, "Goal", true),
      format: text(body.format, 4000, "Format"),
      userInputs: text(body.userInputs, 4000, "Your inputs"),
      brandSummary: text(body.brandSummary, 2000, "Brand summary"),
      budgetUsd: number(body.budgetUsd, "Budget", 0.01, 1000),
      copyBudgetUsd: optionalBudget(body.copyBudgetUsd, "Copy budget"),
      creativeBudgetUsd: optionalBudget(body.creativeBudgetUsd, "Creative budget"),
      voiceBudgetUsd: optionalBudget(body.voiceBudgetUsd, "Voice budget"),
      orchestratorModelId: model === "" ? null : model,
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { sql, organizationId, brandName } = await requireBrand(context.userId, data.brandId, "admin");
    if (data.format === "" && data.userInputs === "") throw new Error("Give the format to rebuild or make, or your own inputs.");
    const model = data.orchestratorModelId ?? (await getOrchestratorModel(sql, organizationId));
    if (model === null) throw new Error("Choose the orchestrating model in the Content Factory panel first.");
    // A category the user leaves unset is absent from the brief (JSON drops it), so the orchestrator splits that category (categories.ts).
    const brief = {
      goal: data.goal,
      format: data.format === "" ? OWN_INPUTS_FORMAT : data.format,
      userInputs: data.userInputs,
      brand: { name: brandName, summary: data.brandSummary },
      budgetUsd: data.budgetUsd,
      copyBudgetUsd: data.copyBudgetUsd,
      creativeBudgetUsd: data.creativeBudgetUsd,
      voiceBudgetUsd: data.voiceBudgetUsd,
    };
    const stored = await createPlanDraft(sql, {
      id: `plan_${randomUUID().replace(/-/g, "")}`,
      organizationId,
      title: data.title,
      brief,
      orchestratorModel: model,
      budgetUsd: data.budgetUsd,
    });
    return { plan: summaryOf(stored) };
  });

export const planOrchestratorDraft = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return { brandId: text(body.brandId, 80, "Brand", true), planId: text(body.planId, 80, "Plan", true) };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { sql, organizationId, now } = await requireBrand(context.userId, data.brandId, "admin");
    const outcome = await planDraftFor(sql, { organizationId, planId: data.planId, now });
    if (outcome.status === "not_connected" || outcome.status === "failed") return { status: outcome.status, reason: outcome.reason };
    if (outcome.status === "ok") throw new Error("The catalog state does not match the outcome.");
    if (outcome.status === "not_found") throw new Error("Plan not found.");
    if (outcome.status === "not_planned") return { status: "not_planned", reasons: outcome.reasons, plan: summaryOf(outcome.stored) };
    if (outcome.status === "refused") return { status: "refused", reasons: outcome.reasons, plan: summaryOf(outcome.stored) };
    if (!("stored" in outcome)) throw new Error("The plan outcome has no stored plan.");
    return { status: "ready", reasons: [], plan: summaryOf(outcome.stored) };
  });

export const runOrchestratorPlan = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return { brandId: text(body.brandId, 80, "Brand", true), planId: text(body.planId, 80, "Plan", true) };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { sql, organizationId, now } = await requireBrand(context.userId, data.brandId, "admin");
    const outcome = await runPlanFor(sql, { organizationId, planId: data.planId, now });
    if (outcome.status === "not_connected" || outcome.status === "failed") return { status: outcome.status, reason: outcome.reason };
    if (outcome.status === "ok") throw new Error("The catalog state does not match the outcome.");
    if (outcome.status === "not_found") throw new Error("Plan not found.");
    if (outcome.status === "not_runnable") return { status: "not_runnable", reasons: outcome.reasons };
    const stored = await getPlan(sql, organizationId, data.planId);
    if (!("spentUsd" in outcome)) throw new Error("The run did not finish.");
    return { status: outcome.status, spentUsd: outcome.spentUsd, plan: stored ? summaryOf(stored) : null };
  });

export const editOrchestratorStep = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    const patch: Record<string, number | string> = {};
    if (body.seconds !== undefined) patch.seconds = number(body.seconds, "Seconds", 1, 60);
    if (body.characters !== undefined) patch.characters = number(body.characters, "Characters", 1, 20000);
    if (body.maxTokens !== undefined) patch.max_tokens = number(body.maxTokens, "Output tokens", 1, 32000);
    const model = body.modelId === undefined || body.modelId === null || body.modelId === "" ? undefined : text(body.modelId, 200, "Model", true);
    if (model !== undefined && !MODEL_ID.test(model)) throw new Error("The model must be an OpenRouter id, vendor/model.");
    return {
      brandId: text(body.brandId, 80, "Brand", true),
      planId: text(body.planId, 80, "Plan", true),
      nodeId: text(body.nodeId, 40, "Step", true),
      patch,
      modelId: model,
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { sql, organizationId, now } = await requireBrand(context.userId, data.brandId, "admin");
    const stored = await getPlan(sql, organizationId, data.planId);
    if (stored === null || stored.plan === null) throw new Error("Plan not found.");
    const node = stored.plan.nodes.find((candidate) => candidate.id === data.nodeId);
    if (node === undefined) throw new Error("That step is not in this plan.");
    const change: NodeChange = {
      params: { ...node.params, ...data.patch },
      ...(data.modelId === undefined ? {} : { model: { provider: "openrouter", id: data.modelId } }),
    };
    const outcome = await editPlanStepFor(sql, { organizationId, planId: data.planId, nodeId: data.nodeId, change, now });
    if (outcome.status === "not_connected" || outcome.status === "failed") return { status: outcome.status, reason: outcome.reason };
    if (outcome.status === "ok") throw new Error("The catalog state does not match the outcome.");
    if (outcome.status === "not_found") throw new Error("Plan not found.");
    if (outcome.status === "refused") return { status: "refused", reasons: outcome.reasons };
    const after = await getPlan(sql, organizationId, data.planId);
    return { status: "edited", plan: after ? summaryOf(after) : null };
  });

/** The orchestrator model stored for a workspace, for the Content Factory panel. Admin only, like the rest of that screen. */
/** The workspace's budget tolerance and switched-off model families, with the initial values. Any member of the brand's workspace reads it. */
export const getOrchestratorPolicyFor = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ brandId: text(objectInput(input).brandId, 80, "Brand", true) }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { sql, organizationId } = await requireBrand(context.userId, data.brandId, "viewer");
    return { policy: await readOrchestratorPolicy(sql, organizationId), initial: INITIAL_POLICY };
  });

/** Save the policy. Only a workspace admin changes it. An absent field keeps its value; the engine's schema checks every value it is given. */
export const saveOrchestratorPolicyFor = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    const tolerance = body.budgetTolerance === undefined ? undefined : objectInput(body.budgetTolerance);
    const families = Array.isArray(body.disabledModelFamilies) ? body.disabledModelFamilies.map((family) => text(family, 200, "Model family")) : undefined;
    return {
      brandId: text(body.brandId, 80, "Brand", true),
      disabledModelFamilies: families === undefined ? undefined : families.filter((family) => family !== ""),
      budgetTolerance:
        tolerance === undefined
          ? undefined
          : { percent: number(tolerance.percent, "Tolerance percent", 0, 100), cents: number(tolerance.cents, "Tolerance cents", 0, 10000) },
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { sql, organizationId } = await requireBrand(context.userId, data.brandId, "admin");
    const policy = await writeOrchestratorPolicy(sql, {
      organizationId,
      actorId: context.userId,
      patch: { disabledModelFamilies: data.disabledModelFamilies, budgetTolerance: data.budgetTolerance },
    });
    return { policy };
  });

/** Approve a paused plan's budget: the amount the person approves becomes the budget the run is held to. Only a workspace admin approves. */
export const approveOrchestratorBudget = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return {
      brandId: text(body.brandId, 80, "Brand", true),
      planId: text(body.planId, 80, "Plan", true),
      budgetUsd: number(body.budgetUsd, "Budget", 0.01, 1000),
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { sql, organizationId } = await requireBrand(context.userId, data.brandId, "admin");
    const outcome = await approvePlanBudget(sql, { organizationId, planId: data.planId, budgetUsd: data.budgetUsd });
    if (outcome.status === "not_found") throw new Error("Plan not found.");
    if (outcome.status === "refused") return { status: "refused" as const, reasons: outcome.reasons };
    const stored = await getPlan(sql, organizationId, data.planId);
    return {
      status: "approved" as const,
      previousUsd: outcome.previousUsd,
      budgetUsd: outcome.budgetUsd,
      plan: stored === null ? null : summaryOf(stored),
    };
  });

export const getOrchestratorModelSetting = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ organizationId: text(objectInput(input).organizationId, 80, "Workspace", true) }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireWorkspaceAdmin(sql, context.userId, data.organizationId);
    return { orchestratorModel: await getOrchestratorModel(sql, data.organizationId) };
  });

/** The stored model of the brand's workspace, for the plans section. A viewer may read it: it is not a secret. */
export const getBrandOrchestratorModel = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ brandId: text(objectInput(input).brandId, 80, "Brand", true) }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { sql, organizationId } = await requireBrand(context.userId, data.brandId, "viewer");
    return { orchestratorModel: await getOrchestratorModel(sql, organizationId) };
  });

/** The text models the orchestrator can plan with, from the live catalog. Not connected means nothing is listed, and nothing is guessed. */
export const listOrchestratorTextModels = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ organizationId: text(objectInput(input).organizationId, 80, "Workspace", true) }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireWorkspaceAdmin(sql, context.userId, data.organizationId);
    return textModelsFor(sql, { organizationId: data.organizationId, now: () => new Date().toISOString() });
  });

/**
 * Stores the workspace's orchestrator model, or clears it with null. When the catalog is connected, the model must be one of its text
 * models with prices, and the answer says so. When it is not connected, the id is stored as typed (its shape is checked) and the answer
 * says it is not checked yet: the plan checks it against the catalog when the plan is written.
 */
export const saveOrchestratorModelSetting = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    const raw = body.orchestratorModelId;
    const modelId = raw === undefined || raw === null || raw === "" ? null : text(raw, 200, "Orchestrating model", true);
    if (modelId !== null && !isOrchestratorModelId(modelId)) throw new Error("The orchestrating model must be an OpenRouter id, vendor/model.");
    return { organizationId: text(body.organizationId, 80, "Workspace", true), orchestratorModelId: modelId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireWorkspaceAdmin(sql, context.userId, data.organizationId);
    let checkedAgainstCatalog = false;
    if (data.orchestratorModelId !== null) {
      const read = await textModelsFor(sql, { organizationId: data.organizationId, now: () => new Date().toISOString() });
      if (read.status === "ok") {
        if (!read.models.some((model) => model.id === data.orchestratorModelId)) {
          throw new Error(`${data.orchestratorModelId} is not a text model with prices in the live catalog. Nothing was saved.`);
        }
        checkedAgainstCatalog = true;
      }
    }
    await setOrchestratorModel(sql, { organizationId: data.organizationId, modelId: data.orchestratorModelId, actorId: context.userId });
    return { orchestratorModel: data.orchestratorModelId, checkedAgainstCatalog };
  });
