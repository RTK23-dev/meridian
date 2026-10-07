import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { requireBrandAccess } from "../distribution/service.ts";
import {
  listBrandPlatformAccounts,
  connectPlatformAccount,
  disconnectPlatformAccount,
  type ConnectAccountInput,
} from "./manager.ts";

function clip(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

export const getPlatformAccountsAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const brandId = clip(body.brandId);
    const platform = typeof body.platform === "string" ? clip(body.platform) : undefined;
    if (!brandId) throw new Error("Choose a brand.");
    return { brandId, platform };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrandAccess(sql, context.userId, data.brandId, "viewer");
    return listBrandPlatformAccounts(sql, access.organizationId, data.brandId, data.platform);
  });

export const connectPlatformAccountAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const brandId = clip(body.brandId);
    const platform = clip(body.platform);
    const externalAccountId = clip(body.externalAccountId);
    const name = clip(body.name);
    const handle = typeof body.handle === "string" ? clip(body.handle) : "";
    const avatarUrl = typeof body.avatarUrl === "string" ? clip(body.avatarUrl) : "";
    const accountType = typeof body.accountType === "string" ? clip(body.accountType) : "social_page";
    const token = typeof body.token === "string" ? body.token.trim() : "";

    if (!brandId) throw new Error("Choose a brand.");
    if (!platform) throw new Error("Select a platform.");
    if (!externalAccountId || !name) throw new Error("Provide account ID and name.");

    const credentials = token ? { accessToken: token } : undefined;

    return {
      brandId,
      account: {
        platform,
        accountType,
        externalAccountId,
        name,
        handle,
        avatarUrl,
        credentials,
      } as ConnectAccountInput,
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrandAccess(sql, context.userId, data.brandId, "member");
    return connectPlatformAccount(sql, access.organizationId, data.brandId, data.account);
  });

export const disconnectPlatformAccountAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const brandId = clip(body.brandId);
    const accountId = clip(body.accountId);
    if (!brandId || !accountId) throw new Error("Choose a brand and account.");
    return { brandId, accountId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrandAccess(sql, context.userId, data.brandId, "admin");
    return disconnectPlatformAccount(sql, access.organizationId, data.brandId, data.accountId);
  });
