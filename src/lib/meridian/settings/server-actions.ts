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
