import assert from "node:assert/strict";
import test from "node:test";
import type { CredentialResolution } from "../credentials/contract.ts";
import type { Sql } from "../learning/store.ts";
import { handleShopifyWebhook, type ShopifyWebhookDeps } from "./handler.ts";

// The bodies and their HMACs are recorded fixtures. Each HMAC is base64 HMAC-SHA256 over the exact body text, keyed with SECRET,
// computed once with openssl: printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64
const SECRET = "shpss_fixture_secret";
const SHOP = "meridian-test.myshopify.com";
const ORG = "org_fixture";
const BRAND = "brand_fixture";
const CREATIVE = "cr_reel_fixture";
const UTM_CONTENT = "mr0123456789ab";
const KEYWORD = "KQ7XW2MN";

const UTM_BODY =
  '{"id":450789469,"name":"#1001","currency":"USD","total_price":"409.94","subtotal_price":"398.00","total_tax":"11.94","total_discounts":"0.00","created_at":"2026-10-14T10:00:00-04:00","landing_site":"/?utm_source=meridian&utm_content=mr0123456789ab","referring_site":"https://www.instagram.com/","source_name":"web","note_attributes":[],"discount_codes":[]}';
const UTM_HMAC = "7fNGjD9Jnpkkvx7H0Jo260Fo+oNcuc10148oFFR5leU=";

const KEYWORD_BODY =
  '{"id":450789470,"name":"#1002","currency":"USD","total_price":"120.00","created_at":"2026-10-14T11:00:00Z","landing_site":"/","note_attributes":[{"name":"dm_keyword","value":"KQ7XW2MN"}],"discount_codes":[{"code":"kq7xw2mn","amount":"5.00","type":"fixed_amount"}]}';
const KEYWORD_HMAC = "lB9xLc2+XoXU1xrNrLj+3b+I03lLhvVjqQlT+I1zA48=";

const UNMATCHED_BODY =
  '{"id":450789471,"name":"#1003","currency":"USD","total_price":"19.99","landing_site":"/","discount_codes":[]}';
const UNMATCHED_HMAC = "Lj5nO6LfAHVtjaEv/VuZhW+Tv1wQiAPffAXRY9gZpWQ=";

const BROKEN_BODY = '{"id":450789472,';
const BROKEN_HMAC = "7gWwKD0dDqt6FuZX8zdfif97fbb2w5pxpiQBoRT5hS4=";

type StoredOrder = { organizationId: string; shopDomain: string; shopifyOrderId: string; creativeId: string | null; matchRule: string | null; utmContent: string | null };

/**
 * An in-memory stand-in for the statements the Shopify handler runs. It answers by the statement text, checks the conflict rule
 * of the order insert, and keeps one row per (organization, shop, Shopify order id), as the unique rule does.
 */
function fakeShopifyDb(shops: Array<{ shop_domain: string; organization_id: string; brand_id: string }>) {
  const orders: StoredOrder[] = [];
  const reads: string[] = [];
  const links = [{ creative_id: CREATIVE, utm_content: UTM_CONTENT, dm_keyword: KEYWORD, organization_id: ORG, brand_id: BRAND }];
  const statement = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").toLowerCase();
    if (text.includes("insert into shopify_orders")) {
      assert.match(text, /on conflict \(organization_id, shop_domain, shopify_order_id\) do nothing/);
      // Positions follow the insert's column list: 0 id, 1 organization, 2 brand, 3 shop, 4 Shopify order id, 15 utm_content,
      // 19 creative_id, 20 match_rule.
      const [, organizationId, , shopDomain, shopifyOrderId, , , , , , , , , , , utmContent, , , , creativeId, matchRule] = values as Array<
        string | null
      >;
      const seen = orders.some(
        (row) => row.organizationId === organizationId && row.shopDomain === shopDomain && row.shopifyOrderId === shopifyOrderId,
      );
      if (seen) return [];
      orders.push({
        organizationId: organizationId ?? "",
        shopDomain: shopDomain ?? "",
        shopifyOrderId: shopifyOrderId ?? "",
        creativeId: creativeId ?? null,
        matchRule: matchRule ?? null,
        utmContent: utmContent ?? null,
      });
      return [{ id: "order-row" }];
    }
    if (text.includes("from shopify_shops")) {
      reads.push("shops");
      const [shopDomain] = values as string[];
      const row = shops.find((shop) => shop.shop_domain === shopDomain);
      return row ? [{ organization_id: row.organization_id, brand_id: row.brand_id }] : [];
    }
    if (text.includes("from reel_attributions")) {
      reads.push("links");
      const [organizationId, brandId] = values as string[];
      return links
        .filter((link) => link.organization_id === organizationId && link.brand_id === brandId)
        .map((link) => ({ creative_id: link.creative_id, utm_content: link.utm_content, dm_keyword: link.dm_keyword }));
    }
    throw new Error(`The fake database does not answer this statement: ${text}`);
  };
  return { sql: statement as unknown as Sql, orders, reads };
}

function delivery(body: string, options: { hmac?: string; topic?: string; contentType?: string; shop?: string } = {}): Request {
  return new Request("https://meridian.test/api/webhooks/shopify", {
    method: "POST",
    headers: {
      "content-type": options.contentType ?? "application/json",
      "x-shopify-shop-domain": options.shop ?? SHOP,
      "x-shopify-topic": options.topic ?? "orders/create",
      "x-shopify-hmac-sha256": options.hmac ?? "",
      "x-shopify-webhook-id": "wh_fixture",
    },
    body,
  });
}

const READY: CredentialResolution = { status: "ready", source: "workspace", secret: SECRET, fingerprint: "...ture" };

function depsFor(db: ReturnType<typeof fakeShopifyDb>, resolved: CredentialResolution = READY): ShopifyWebhookDeps {
  return {
    sql: async () => db.sql,
    resolveSecret: async (organizationId: string) => {
      assert.equal(organizationId, ORG);
      return resolved;
    },
  };
}

const CONNECTED = [{ shop_domain: SHOP, organization_id: ORG, brand_id: BRAND }];

test("a request that is not JSON is refused before anything is read", async () => {
  const db = fakeShopifyDb(CONNECTED);
  const response = await handleShopifyWebhook(delivery(UTM_BODY, { hmac: UTM_HMAC, contentType: "text/plain" }), depsFor(db));
  assert.equal(response.status, 415);
  assert.equal(db.orders.length, 0);
  assert.equal(db.reads.length, 0);
});

test("an unknown shop is refused with the same answer as a bad signature, and nothing is stored", async () => {
  const db = fakeShopifyDb(CONNECTED);
  const response = await handleShopifyWebhook(
    delivery(UTM_BODY, { hmac: UTM_HMAC, shop: "other-store.myshopify.com" }),
    depsFor(db),
  );
  assert.equal(response.status, 401);
  assert.equal(await response.text(), "The webhook was not accepted.");
  assert.equal(db.orders.length, 0);
});

test("a shop with no usable secret is answered NOT_CONNECTED and nothing is stored", async () => {
  const db = fakeShopifyDb(CONNECTED);
  const missing: CredentialResolution = { status: "not_configured", reason: "This workspace has no saved Shopify credential." };
  const response = await handleShopifyWebhook(delivery(UTM_BODY, { hmac: UTM_HMAC }), depsFor(db, missing));
  assert.equal(response.status, 503);
  assert.match(await response.text(), /^NOT_CONNECTED: /);
  assert.equal(db.orders.length, 0);
});

test("a delivery whose signature does not match its body is refused, and the secret is not echoed", async () => {
  const db = fakeShopifyDb(CONNECTED);
  const response = await handleShopifyWebhook(delivery(UNMATCHED_BODY, { hmac: UTM_HMAC }), depsFor(db));
  assert.equal(response.status, 401);
  const text = await response.text();
  assert.equal(text, "HMAC validation failed.");
  assert.equal(text.includes(SECRET), false);
  assert.equal(db.orders.length, 0);
});

test("a topic other than orders/create is acknowledged and not stored", async () => {
  const db = fakeShopifyDb(CONNECTED);
  const response = await handleShopifyWebhook(delivery(UTM_BODY, { hmac: UTM_HMAC, topic: "products/update" }), depsFor(db));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /^ignored: /);
  assert.equal(db.orders.length, 0);
});

test("an order whose landing site carries the reel's utm_content is stored against that reel by the utm rule", async () => {
  const db = fakeShopifyDb(CONNECTED);
  const response = await handleShopifyWebhook(delivery(UTM_BODY, { hmac: UTM_HMAC }), depsFor(db));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "recorded");
  assert.equal(db.orders.length, 1);
  assert.deepEqual(db.orders[0], {
    organizationId: ORG,
    shopDomain: SHOP,
    shopifyOrderId: "450789469",
    creativeId: CREATIVE,
    matchRule: "utm_content",
    utmContent: UTM_CONTENT,
  });
});

test("a repeat of the same order is answered already received, and the first stored copy stands", async () => {
  const db = fakeShopifyDb(CONNECTED);
  await handleShopifyWebhook(delivery(UTM_BODY, { hmac: UTM_HMAC }), depsFor(db));
  const again = await handleShopifyWebhook(delivery(UTM_BODY, { hmac: UTM_HMAC }), depsFor(db));
  assert.equal(again.status, 200);
  assert.equal(await again.text(), "already received");
  assert.equal(db.orders.length, 1);
});

test("an order with the DM keyword as a discount code is matched by the keyword rule", async () => {
  const db = fakeShopifyDb(CONNECTED);
  const response = await handleShopifyWebhook(delivery(KEYWORD_BODY, { hmac: KEYWORD_HMAC }), depsFor(db));
  assert.equal(response.status, 200);
  assert.equal(db.orders[0]?.creativeId, CREATIVE);
  assert.equal(db.orders[0]?.matchRule, "dm_keyword");
});

test("an order that no reel matches is stored with null, never guessed to a reel", async () => {
  const db = fakeShopifyDb(CONNECTED);
  const response = await handleShopifyWebhook(delivery(UNMATCHED_BODY, { hmac: UNMATCHED_HMAC }), depsFor(db));
  assert.equal(response.status, 200);
  assert.equal(db.orders[0]?.creativeId, null);
  assert.equal(db.orders[0]?.matchRule, null);
});

test("a signed body that is not JSON is refused with 400 and nothing is stored", async () => {
  const db = fakeShopifyDb(CONNECTED);
  const response = await handleShopifyWebhook(delivery(BROKEN_BODY, { hmac: BROKEN_HMAC }), depsFor(db));
  assert.equal(response.status, 400);
  assert.equal(db.orders.length, 0);
});
