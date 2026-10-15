/**
 * Receives a Shopify orders/create delivery for one workspace's shop. Each refusal leaves nothing stored.
 *
 * The order of checks is fixed. The media type is checked first (415). The body is read within the cap and the deadline (413,
 * 408). The shop domain must be a myshopify.com domain, and it must be connected to a workspace (401, the same answer as a bad
 * signature, so an unsigned caller learns nothing). The workspace's Shopify secret must be usable (503 NOT_CONNECTED). The HMAC
 * over the raw body must match (401). Only then is the JSON read (400 when malformed), the order matched to a reel, and the
 * order stored by its Shopify id (202 "recorded", or 200 "already received" for a repeat).
 *
 * The body is untrusted data. It is validated, and it is never rendered as HTML or run.
 */
import type { CredentialResolution } from "../credentials/contract.ts";
import type { Sql } from "../learning/store.ts";
import { readBoundedBody, WEBHOOK_BODY_DEADLINE_MS } from "../webhooks/receive-handler.ts";
import { matchOrderToReel, signalsOf } from "./attribution.ts";
import { parseShopifyOrder, SHOPIFY_ORDERS_CREATE_TOPIC, utmOfLandingSite } from "./order.ts";
import { reelLinksOf, shopForDomain, storeShopifyOrder } from "./store.ts";
import { verifyShopifyHmac } from "./verify.ts";

export interface ShopifyWebhookDeps {
  /** Opens the database. Called only after the body is read, so a refused body does not reach it. */
  sql: () => Promise<Sql>;
  /** Resolves the workspace's Shopify secret (the credential category `shopify`). Production passes the one resolver. */
  resolveSecret: (organizationId: string) => Promise<CredentialResolution>;
  /** How long the whole body may take to arrive. Defaults to WEBHOOK_BODY_DEADLINE_MS. Tests shorten it. */
  bodyDeadlineMs?: number;
}

/** The shop domain Shopify sends: a myshopify.com domain, in lowercase. */
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]{0,99}\.myshopify\.com$/;

/** The answer for an unknown shop and for a bad signature alike. */
const NOT_ACCEPTED = "The webhook was not accepted.";

function refusal(message: string, status: number): Response {
  return new Response(message, { status });
}

function isJsonContentType(value: string | null): boolean {
  return (value ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";
}

export async function handleShopifyWebhook(request: Request, deps: ShopifyWebhookDeps): Promise<Response> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return refusal("Shopify webhook payloads must be application/json.", 415);
  }
  const body = await readBoundedBody(request, deps.bodyDeadlineMs ?? WEBHOOK_BODY_DEADLINE_MS);
  if ("refusal" in body) return body.refusal;

  const shopDomain = (request.headers.get("x-shopify-shop-domain") ?? "").trim().toLowerCase();
  if (!SHOP_DOMAIN.test(shopDomain)) return refusal(NOT_ACCEPTED, 401);

  const sql = await deps.sql();
  const shop = await shopForDomain(sql, shopDomain);
  if (!shop) {
    console.warn(`[shopify] Refused a delivery from ${shopDomain}: the shop is not connected to a workspace.`);
    return refusal(NOT_ACCEPTED, 401);
  }

  let resolved: CredentialResolution | null = null;
  try {
    resolved = await deps.resolveSecret(shop.organizationId);
  } catch {
    resolved = null;
  }
  if (!resolved) {
    return refusal("NOT_CONNECTED: The Shopify secret could not be checked, so the order was not stored.", 503);
  }
  const secret = resolved;
  if (secret.status !== "ready") {
    // A known shop with no usable secret. The reason names the saved entry and holds no key.
    return refusal(`NOT_CONNECTED: ${secret.reason}`, 503);
  }

  const verdict = verifyShopifyHmac({
    rawBody: body.text,
    header: request.headers.get("x-shopify-hmac-sha256") ?? "",
    secret: secret.secret,
  });
  if (!verdict.ok) {
    console.warn(`[shopify] Refused a delivery from ${shopDomain}: ${verdict.reason}`);
    return refusal("HMAC validation failed.", 401);
  }

  const topic = (request.headers.get("x-shopify-topic") ?? "").trim();
  if (topic !== SHOPIFY_ORDERS_CREATE_TOPIC) {
    return new Response(`ignored: ${topic || "no topic"} is not stored`, { status: 200 });
  }

  let json: unknown;
  try {
    json = JSON.parse(body.text);
  } catch {
    return refusal("The order payload is not JSON.", 400);
  }
  const order = parseShopifyOrder(json);
  if (!order) return refusal("The order payload could not be read.", 400);

  const signals = signalsOf(order);
  const utm = utmOfLandingSite(order.landingSite);
  const links = await reelLinksOf(sql, shop.organizationId, shop.brandId);
  const match = matchOrderToReel(signals, links);

  const stored = await storeShopifyOrder(sql, {
    organizationId: shop.organizationId,
    brandId: shop.brandId,
    shopDomain,
    order,
    utmContent: utm.utmContent,
    utmCampaign: utm.utmCampaign,
    creativeId: match?.creativeId ?? null,
    matchRule: match?.rule ?? null,
  });
  return stored ? new Response("recorded", { status: 202 }) : new Response("already received", { status: 200 });
}
