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
