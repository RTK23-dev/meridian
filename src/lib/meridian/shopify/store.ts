/**
 * The Shopify statements: the shop a webhook belongs to, the reel links an order is matched against, the idempotent order insert,
 * and the per-reel sales summary. Every statement is scoped to one organization, and the summary reads only stored rows.
 */
import type { Sql } from "../learning/store.ts";
import type { ReelLink } from "./attribution.ts";
import type { ShopifyOrder } from "./order.ts";

export type ShopRoute = { organizationId: string; brandId: string; shopDomain: string };

/** The workspace and brand a shop's webhooks belong to. Null for a shop that is unknown or disconnected. */
export async function shopForDomain(sql: Sql, shopDomain: string): Promise<ShopRoute | null> {
  const rows = await sql<{ organization_id: string; brand_id: string }>`
    select organization_id, brand_id from shopify_shops
    where shop_domain = ${shopDomain} and disconnected_at is null
    limit 1
  `;
  const row = rows[0];
  return row ? { organizationId: row.organization_id, brandId: row.brand_id, shopDomain } : null;
}

/** Records a shop for a brand. A shop already connected to another workspace is refused, and nothing changes. */
export async function connectShopifyShop(
  sql: Sql,
  input: { organizationId: string; brandId: string; shopDomain: string; actorId: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const rows = await sql<{ shop_domain: string }>`
    insert into shopify_shops (id, organization_id, brand_id, shop_domain, connected_by, connected_at, disconnected_at)
    values (${crypto.randomUUID()}, ${input.organizationId}, ${input.brandId}, ${input.shopDomain}, ${input.actorId}, now(), null)
    on conflict (shop_domain) do update set
      brand_id = excluded.brand_id,
      connected_by = excluded.connected_by,
      connected_at = excluded.connected_at,
      disconnected_at = null
    where shopify_shops.organization_id = excluded.organization_id
    returning shop_domain
  `;
  if (!rows[0]) return { ok: false, reason: "This shop is already connected to another workspace." };
  return { ok: true };
}

export async function disconnectShopifyShop(sql: Sql, input: { organizationId: string; shopDomain: string }): Promise<void> {
  await sql`
    update shopify_shops set disconnected_at = now()
    where organization_id = ${input.organizationId} and shop_domain = ${input.shopDomain} and disconnected_at is null
  `;
}

/** The shop connected to a brand, if any. */
export async function shopOfBrand(
  sql: Sql,
  organizationId: string,
  brandId: string,
): Promise<{ shopDomain: string; connectedAt: string } | null> {
  const rows = await sql<{ shop_domain: string; connected_at: unknown }>`
    select shop_domain, connected_at from shopify_shops
    where organization_id = ${organizationId} and brand_id = ${brandId} and disconnected_at is null
    order by connected_at desc
    limit 1
  `;
  const row = rows[0];
  return row ? { shopDomain: row.shop_domain, connectedAt: String(row.connected_at) } : null;
}

/** Every reel link of the brand that an order can be matched against. */
export async function reelLinksOf(sql: Sql, organizationId: string, brandId: string): Promise<ReelLink[]> {
  const rows = await sql<{ creative_id: string; utm_content: string; dm_keyword: string }>`
    select creative_id, utm_content, dm_keyword from reel_attributions
    where organization_id = ${organizationId} and brand_id = ${brandId}
  `;
  return rows.map((row) => ({ creativeId: row.creative_id, utmContent: row.utm_content, dmKeyword: row.dm_keyword }));
}

/**
 * Stores one order by its Shopify id. A repeat of the same order (a Shopify retry, or the same order sent again) stores nothing
 * new, and the first stored copy stands. Returns true when this call stored it.
 */
export async function storeShopifyOrder(
  sql: Sql,
  input: {
    organizationId: string;
    brandId: string;
    shopDomain: string;
    order: ShopifyOrder;
    utmContent: string | null;
    utmCampaign: string | null;
    creativeId: string | null;
    matchRule: "utm_content" | "dm_keyword" | null;
  },
): Promise<boolean> {
  const { order } = input;
  const rows = await sql<{ id: string }>`
    insert into shopify_orders (
      id, organization_id, brand_id, shop_domain, shopify_order_id, order_name, currency, total_price, subtotal_price,
      total_tax, total_discounts, ordered_at, landing_site, referring_site, source_name, utm_content, utm_campaign,
      discount_codes, note_attributes, creative_id, match_rule
    ) values (
      ${crypto.randomUUID()}, ${input.organizationId}, ${input.brandId}, ${input.shopDomain}, ${order.shopifyOrderId},
      ${order.orderName}, ${order.currency}, ${order.totalPrice}, ${order.subtotalPrice},
      ${order.totalTax}, ${order.totalDiscounts}, ${order.orderedAt}, ${order.landingSite}, ${order.referringSite},
      ${order.sourceName}, ${input.utmContent}, ${input.utmCampaign},
      ${order.discountCodes === null ? null : JSON.stringify(order.discountCodes)},
      ${order.noteAttributes === null ? null : JSON.stringify(order.noteAttributes)},
      ${input.creativeId}, ${input.matchRule}
    )
    on conflict (organization_id, shop_domain, shopify_order_id) do nothing
    returning id
  `;
  return Boolean(rows[0]);
}

export type ReelSales = {
  creativeId: string;
  title: string;
  dmKeyword: string;
  linkUrl: string | null;
  /** Orders matched to this reel, by either rule. */
  orders: number;
  matchedByUtm: number;
  matchedByKeyword: number;
  /** Orders whose total is not stored. They are counted here, never as zero. */
  unknownTotal: number;
  /** The stored totals, one line per currency. A currency that is not stored is null. */
  byCurrency: Array<{ currency: string | null; orders: number; total: string }>;
};

export type SalesByReel = {
  reels: ReelSales[];
  /** Orders this brand received that no reel matched. They are kept, unattributed. */
  unmatched: number;
};

/** The attributed orders of each reel of a brand, from stored rows only. */
export async function salesByReelOf(sql: Sql, organizationId: string, brandId: string): Promise<SalesByReel> {
  const reels = await sql<{ creative_id: string; title: string; dm_keyword: string; link_url: string | null }>`
    select r.creative_id, coalesce(c.title, '') as title, r.dm_keyword, r.link_url
    from reel_attributions r
    left join creative_records c on c.id = r.creative_id
    where r.organization_id = ${organizationId} and r.brand_id = ${brandId}
    order by r.created_at desc, r.creative_id asc
  `;
  const totals = await sql<{
    creative_id: string;
    match_rule: string | null;
    currency: string | null;
    orders: number;
    unknown_total: number;
    total: string;
  }>`
    select creative_id, match_rule, currency,
      count(*)::int as orders,
      count(*) filter (where total_price is null)::int as unknown_total,
      coalesce(sum(total_price::numeric), 0)::text as total
    from shopify_orders
    where organization_id = ${organizationId} and brand_id = ${brandId} and creative_id is not null
    group by creative_id, match_rule, currency
  `;
  const unmatchedRows = await sql<{ n: number }>`
    select count(*)::int as n from shopify_orders
    where organization_id = ${organizationId} and brand_id = ${brandId} and creative_id is null
  `;

  const byReel = new Map<string, ReelSales>();
  for (const reel of reels) {
    byReel.set(reel.creative_id, {
      creativeId: reel.creative_id,
      title: reel.title,
      dmKeyword: reel.dm_keyword,
      linkUrl: reel.link_url,
      orders: 0,
      matchedByUtm: 0,
      matchedByKeyword: 0,
      unknownTotal: 0,
      byCurrency: [],
    });
  }
  for (const row of totals) {
    const reel = byReel.get(row.creative_id);
    if (!reel) continue;
    reel.orders += Number(row.orders);
    reel.unknownTotal += Number(row.unknown_total);
    if (row.match_rule === "utm_content") reel.matchedByUtm += Number(row.orders);
    if (row.match_rule === "dm_keyword") reel.matchedByKeyword += Number(row.orders);
    reel.byCurrency.push({ currency: row.currency, orders: Number(row.orders), total: row.total });
  }
  return { reels: [...byReel.values()], unmatched: Number(unmatchedRows[0]?.n ?? 0) };
}
