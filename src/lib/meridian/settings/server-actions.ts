import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { requireMembership, objectInput, asText } from "../api-shared";
import {
  getWorkspaceProviderSettings,
  saveWorkspaceProviderConfig,
  removeWorkspaceProviderConfig,
  testWorkspaceProviderConnection,
  type ProviderCategory,
  type ProviderConfigSummary,
} from "./provider-config.ts";
import { getDecisionEngineStatus } from "../decisions/status.ts";
import { createDecisionEngines } from "../decisions/dispatcher.ts";
import { isDecisionEngineId } from "../decisions/types.ts";
import { saveWorkspaceEngine } from "../decisions/selection.ts";
import { OpenRouterDecisionsEngine, validateDecisionModel } from "../decisions/openrouter-engine.ts";
import { recordOpenRouterCheck, writeOpenRouterModel } from "../decisions/openrouter-settings.ts";
import { readWorkspaceVideoBudget, saveWorkspaceVideoBudget } from "./video-budget.ts";

/** The workspace's monthly video budget in US dollars, or null when none is set. Any member may read it. */
export const getVideoBudget = createServerFn({ method: "GET" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    if (!organizationId) throw new Error("organizationId is required.");
    return { organizationId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    // The membership check (viewer or above) runs inside, before the read.
    return readWorkspaceVideoBudget(sql, { userId: context.userId, organizationId: data.organizationId });
  });

/** Saves, or clears with a blank value, the workspace's monthly video budget. Admin only; the role is checked on the server. */
export const saveVideoBudget = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    if (!organizationId) throw new Error("organizationId is required.");
    const value = obj.monthlyVideoBudgetUsd;
    if (value !== null && value !== undefined && typeof value !== "string" && typeof value !== "number") {
      throw new Error("The monthly video budget must be a number or blank.");
    }
    return { organizationId, monthlyVideoBudgetUsd: (value ?? null) as string | number | null };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    // The admin check runs inside, before the value is parsed or written.
    return saveWorkspaceVideoBudget(sql, { userId: context.userId, organizationId: data.organizationId, value: data.monthlyVideoBudgetUsd });
  });

export const getProviderSettings = createServerFn({ method: "GET" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    if (!organizationId) throw new Error("organizationId is required.");
    return { organizationId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }): Promise<Record<ProviderCategory, ProviderConfigSummary>> => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "viewer");
    return getWorkspaceProviderSettings(sql, data.organizationId);
  });

export const saveProviderConfig = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    const category = asText(obj.category) as ProviderCategory;
    if (!organizationId) throw new Error("organizationId is required.");
    if (!category) throw new Error("category is required.");
    const credentials = obj.credentials ? (obj.credentials as Record<string, string>) : undefined;
    const settings = obj.settings ? (obj.settings as Record<string, any>) : undefined;
    return { organizationId, category, credentials, settings };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "admin");

    return saveWorkspaceProviderConfig(sql, {
      organizationId: data.organizationId,
      actorId: context.userId,
      category: data.category,
      credentials: data.credentials,
      settings: data.settings,
    });
  });

export const removeProviderConfig = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    const category = asText(obj.category) as ProviderCategory;
    if (!organizationId) throw new Error("organizationId is required.");
    if (!category) throw new Error("category is required.");
    return { organizationId, category };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "admin");

    return removeWorkspaceProviderConfig(sql, {
      organizationId: data.organizationId,
      actorId: context.userId,
      category: data.category,
    });
  });

export const testProviderConnection = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    const category = asText(obj.category) as ProviderCategory;
    if (!organizationId) throw new Error("organizationId is required.");
    if (!category) throw new Error("category is required.");
    return { organizationId, category };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "admin");

    return testWorkspaceProviderConnection(sql, {
      organizationId: data.organizationId,
      category: data.category,
    });
  });

/** Which decision engine is active for this workspace, and whether each engine is configured. No secrets are returned. */
export const getDecisionEngines = createServerFn({ method: "GET" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    if (!organizationId) throw new Error("organizationId is required.");
    return { organizationId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "viewer");
    return getDecisionEngineStatus(sql, data.organizationId);
  });

/** Switches the active decision engine. Refused unless the target engine is configured; the previous choice is kept. */
export const saveDecisionEngine = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    const engineId = asText(obj.engineId);
    if (!organizationId) throw new Error("organizationId is required.");
    if (!engineId) throw new Error("engineId is required.");
    return { organizationId, engineId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "admin");
    if (!isDecisionEngineId(data.engineId)) {
      return { ok: false as const, reason: `'${data.engineId}' is not a decision engine.` };
    }
    const target = createDecisionEngines()[data.engineId];
    // The engine is checked for this workspace, so its own saved key is the one that decides READY.
    const health = target.healthFor ? await target.healthFor(data.organizationId) : await target.health();
    const result = await saveWorkspaceEngine(sql, {
      organizationId: data.organizationId,
      actorId: context.userId,
      engineId: data.engineId,
      targetHealth: health,
    });
    return result.ok
      ? { ok: true as const, engineId: result.engineId }
      : { ok: false as const, reason: result.reason, activeEngineId: result.previous.engineId };
  });

/**
 * Saves the workspace's OpenRouter decision model. It must be a pinned, verified decision model. Saving it changes no active
 * engine, and it does not count as a passed connection: the connection test is what makes the engine READY.
 */
export const saveOpenRouterDecisionModel = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    const model = asText(obj.model);
    if (!organizationId) throw new Error("organizationId is required.");
    if (!model) throw new Error("model is required.");
    return { organizationId, model };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "admin");
    const checked = validateDecisionModel(data.model);
    if (!checked.ok) return { ok: false as const, reason: checked.reason };
    await writeOpenRouterModel(sql, { organizationId: data.organizationId, actorId: context.userId, model: checked.model });
    const health = await new OpenRouterDecisionsEngine().healthFor(data.organizationId);
    return { ok: true as const, model: checked.model, health };
  });

/**
 * An explicit connection test for the OpenRouter decision engine. It sends one real request, which may incur model usage, and it
 * records the outcome. It changes no product data and no active engine. The result only says whether the provider answered.
 */
export const testOpenRouterDecisionConnection = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const obj = objectInput(input);
    const organizationId = asText(obj.organizationId);
    if (!organizationId) throw new Error("organizationId is required.");
    return { organizationId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await requireMembership(sql, context.userId, data.organizationId, "admin");
    const engine = new OpenRouterDecisionsEngine();
    const outcome = await engine.connectionCheck(data.organizationId);
    if (outcome.kind === "not_run") {
      return { ok: false as const, status: "NOT_RUN" as const, message: outcome.message, health: await engine.healthFor(data.organizationId) };
    }
    await recordOpenRouterCheck(sql, {
      organizationId: data.organizationId,
      actorId: context.userId,
      check: {
        status: outcome.status,
        model: outcome.model,
        keyFingerprint: outcome.keyFingerprint,
        message: outcome.message,
        returnedModel: outcome.returnedModel,
        upstreamProvider: outcome.upstreamProvider,
        providerRequestId: outcome.providerRequestId,
      },
    });
    return {
      ok: outcome.status === "passed",
      status: outcome.status === "passed" ? ("PASSED" as const) : ("FAILED" as const),
      message: outcome.message,
      health: await engine.healthFor(data.organizationId),
    };
  });
