/**
 * The Shopify order payload, read for sales attribution. The body is untrusted: the required shape is checked with zod, and each
 * other field is normalised on its own, so a malformed money value or text becomes null (unknown), and the order is still kept.
 *
 * The topic is orders/create. Shopify documents its sample payload as an Order object at the top level, with id, name,
 * total_price, subtotal_price, total_tax, currency, created_at, landing_site, referring_site, source_name, note_attributes
 * ([{name, value}]) and discount_codes ([{code, amount, type}]). The reference pages do not describe those attribution fields in
 * words, so this reader relies on the sample shapes only. Sources (retrieved 2026-10-15):
 *   https://shopify.dev/docs/api/webhooks/2026-01 (orders/create: sample payload)
 *   https://shopify.dev/docs/api/admin-rest/2026-01/resources/order (sample payload, discount_codes)
 */
import { z } from "zod";

export const SHOPIFY_ORDERS_CREATE_TOPIC = "orders/create";

const MAX_TEXT = 2000;
const MAX_CODES = 50;
const MONEY = /^\d{1,12}(\.\d{1,4})?$/;

const OrderId = z.union([z.number().int().positive(), z.string().regex(/^\d{1,20}$/)]);

export const ShopifyOrderPayload = z.object({
  id: OrderId,
  name: z.unknown(),
  currency: z.unknown(),
  total_price: z.unknown(),
  subtotal_price: z.unknown(),
  total_tax: z.unknown(),
  total_discounts: z.unknown(),
  created_at: z.unknown(),
  landing_site: z.unknown(),
  referring_site: z.unknown(),
  source_name: z.unknown(),
  note_attributes: z.unknown(),
  discount_codes: z.unknown(),
});

export type ShopifyOrderPayload = z.infer<typeof ShopifyOrderPayload>;

export type ShopifyOrder = {
  shopifyOrderId: string;
  orderName: string | null;
  currency: string | null;
  totalPrice: string | null;
  subtotalPrice: string | null;
  totalTax: string | null;
  totalDiscounts: string | null;
  orderedAt: string | null;
  landingSite: string | null;
  referringSite: string | null;
  sourceName: string | null;
  discountCodes: string[] | null;
  noteAttributes: Array<{ name: string; value: string }> | null;
};

/** A money amount as the text Shopify sends (for example 409.94), or null when the value is not one. Never a float. */
function moneyOf(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return MONEY.test(trimmed) ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    const text = String(value);
    return MONEY.test(text) ? text : null;
  }
  return null;
}

function textOf(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, max);
  return trimmed === "" ? null : trimmed;
}

function currencyOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function orderedAtOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function discountCodesOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const codes: string[] = [];
  for (const entry of value.slice(0, MAX_CODES)) {
    if (!entry || typeof entry !== "object") continue;
    const code = textOf((entry as { code?: unknown }).code, 255);
    if (code) codes.push(code);
  }
  return codes;
}

function noteAttributesOf(value: unknown): Array<{ name: string; value: string }> | null {
  if (!Array.isArray(value)) return null;
  const notes: Array<{ name: string; value: string }> = [];
  for (const entry of value.slice(0, MAX_CODES)) {
    if (!entry || typeof entry !== "object") continue;
    const name = textOf((entry as { name?: unknown }).name, 200);
    if (!name) continue;
    notes.push({ name, value: textOf((entry as { value?: unknown }).value, MAX_TEXT) ?? "" });
  }
  return notes;
}

/** Normalises a parsed payload. Nothing is invented: a field that is absent or malformed is null. */
export function orderFromPayload(payload: ShopifyOrderPayload): ShopifyOrder {
  return {
    shopifyOrderId: String(payload.id),
    orderName: textOf(payload.name, 40),
    currency: currencyOf(payload.currency),
    totalPrice: moneyOf(payload.total_price),
    subtotalPrice: moneyOf(payload.subtotal_price),
    totalTax: moneyOf(payload.total_tax),
    totalDiscounts: moneyOf(payload.total_discounts),
    orderedAt: orderedAtOf(payload.created_at),
    landingSite: textOf(payload.landing_site, MAX_TEXT),
    referringSite: textOf(payload.referring_site, MAX_TEXT),
    sourceName: textOf(payload.source_name, 200),
    discountCodes: discountCodesOf(payload.discount_codes),
    noteAttributes: noteAttributesOf(payload.note_attributes),
  };
}

/** Reads the payload from parsed JSON. Null when the shape is wrong (no order id, not an object). */
export function parseShopifyOrder(json: unknown): ShopifyOrder | null {
  const parsed = ShopifyOrderPayload.safeParse(json);
  return parsed.success ? orderFromPayload(parsed.data) : null;
}

const SAMPLE_BASE = "https://shop.invalid";

/**
 * The UTM values in a landing site. Shopify sends landing_site as a path with its query, such as "/?utm_content=x", so it is
 * parsed against a placeholder base. Nothing is fetched. A value that is absent or longer than 200 characters is null.
 */
export function utmOfLandingSite(landingSite: string | null): { utmContent: string | null; utmCampaign: string | null } {
  if (!landingSite) return { utmContent: null, utmCampaign: null };
  let url: URL;
  try {
    url = new URL(landingSite, SAMPLE_BASE);
  } catch {
    return { utmContent: null, utmCampaign: null };
  }
  const read = (key: string): string | null => {
    const value = url.searchParams.get(key)?.trim() ?? "";
    return value !== "" && value.length <= 200 ? value : null;
  };
  return { utmContent: read("utm_content"), utmCampaign: read("utm_campaign") };
}
