import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { requireBrand } from "@/lib/meridian/brand-membership";
import { credentialStateOf, type CredentialState } from "../credentials/contract.ts";
import { resolveCredential } from "../credentials/resolve.ts";
import { connectShopifyShop, disconnectShopifyShop, salesByReelOf, shopOfBrand, type SalesByReel } from "./store.ts";

/** The path a merchant pastes into Shopify as the orders/create webhook address. */
export const SHOPIFY_WEBHOOK_PATH = "/api/webhooks/shopify";

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]{0,99}\.myshopify\.com$/;

function clip(value: unknown, max: number, label: string, required = false): string {
  if (typeof value !== "string") {
    if (!required && (value === undefined || value === null)) return "";
    throw new Error(`${label} must be text.`);
  }
  const trimmed = value.trim();
  if (required && !trimmed) throw new Error(`${label} is required.`);
  if (trimmed.length > max) throw new Error(`${label} is too long.`);
  return trimmed;
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid request.");
  return input as Record<string, unknown>;
}

export type ShopifySalesView = {
  webhookPath: string;
  shop: { shopDomain: string; connectedAt: string } | null;
  /** The workspace's Shopify secret, as the resolver reports it. It carries no key. */
  secret: CredentialState;
  sales: SalesByReel;
};

/** The brand's Shopify connection and the attributed orders per reel. Readable by every member of the brand. */
export const getShopifySales = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return { brandId: clip(body.brandId, 80, "Brand", true) };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }): Promise<ShopifySalesView> => {
    const sql = await getSql();
    const { organizationId } = await requireBrand(sql, context.userId, data.brandId, "viewer");
    const shop = await shopOfBrand(sql, organizationId, data.brandId);
    const secret = credentialStateOf(await resolveCredential(sql, organizationId, "shopify"));
    const sales = await salesByReelOf(sql, organizationId, data.brandId);
    return { webhookPath: SHOPIFY_WEBHOOK_PATH, shop, secret, sales };
  });

/** Connects the brand's Shopify shop by its myshopify.com domain. Only an admin can connect a shop. */
export const connectShopifyStore = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return {
      brandId: clip(body.brandId, 80, "Brand", true),
      shopDomain: clip(body.shopDomain, 120, "Shop domain", true).toLowerCase(),
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    if (!SHOP_DOMAIN.test(data.shopDomain)) {
      throw new Error("The shop domain must end in myshopify.com, such as your-store.myshopify.com.");
    }
    const sql = await getSql();
    const { organizationId } = await requireBrand(sql, context.userId, data.brandId, "admin");
    const result = await connectShopifyShop(sql, {
      organizationId,
      brandId: data.brandId,
      shopDomain: data.shopDomain,
      actorId: context.userId,
    });
    if (!result.ok) throw new Error(result.reason);
    return { ok: true as const, shopDomain: data.shopDomain };
  });

/** Disconnects the brand's shop. Orders already stored stay where they are. */
export const disconnectShopifyStore = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return {
      brandId: clip(body.brandId, 80, "Brand", true),
      shopDomain: clip(body.shopDomain, 120, "Shop domain", true).toLowerCase(),
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const { organizationId } = await requireBrand(sql, context.userId, data.brandId, "admin");
    await disconnectShopifyShop(sql, { organizationId, shopDomain: data.shopDomain });
    return { ok: true as const };
  });
