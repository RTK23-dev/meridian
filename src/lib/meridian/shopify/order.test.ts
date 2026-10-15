import assert from "node:assert/strict";
import test from "node:test";
import { parseShopifyOrder, utmOfLandingSite } from "./order.ts";

// The sample shape Shopify documents for an Order (orders/create sample payload and the Order resource examples).
const SAMPLE = {
  id: 450789469,
  name: "#1001",
  currency: "usd",
  total_price: "409.94",
  subtotal_price: "398.00",
  total_tax: "11.94",
  total_discounts: "0.00",
  created_at: "2008-01-10T11:00:00-05:00",
  landing_site: "/?source=abc&utm_content=mr0123456789ab",
  referring_site: "http://www.anexample.com",
  source_name: "instagram",
  note_attributes: [{ name: "dm_keyword", value: "KQ7XW2MN" }],
  discount_codes: [{ code: "SPRING30", amount: "30.00", type: "fixed_amount" }],
};

test("a sample order is read into its id, totals, currency, time and attribution fields", () => {
  const order = parseShopifyOrder(SAMPLE);
  assert.ok(order);
  assert.equal(order.shopifyOrderId, "450789469");
  assert.equal(order.orderName, "#1001");
  assert.equal(order.currency, "USD");
  assert.equal(order.totalPrice, "409.94");
  assert.equal(order.subtotalPrice, "398.00");
  assert.equal(order.totalTax, "11.94");
  assert.equal(order.orderedAt, "2008-01-10T16:00:00.000Z");
  assert.equal(order.landingSite, "/?source=abc&utm_content=mr0123456789ab");
  assert.equal(order.referringSite, "http://www.anexample.com");
  assert.equal(order.sourceName, "instagram");
  assert.deepEqual(order.discountCodes, ["SPRING30"]);
  assert.deepEqual(order.noteAttributes, [{ name: "dm_keyword", value: "KQ7XW2MN" }]);
});

test("a malformed money value, currency or time becomes null, and the order is still read", () => {
  const order = parseShopifyOrder({ ...SAMPLE, total_price: "12,50", subtotal_price: -1, currency: "US", created_at: "not a date" });
  assert.ok(order);
  assert.equal(order.totalPrice, null);
  assert.equal(order.subtotalPrice, null);
  assert.equal(order.currency, null);
  assert.equal(order.orderedAt, null);
  assert.equal(order.totalTax, "11.94");
});

test("a money value sent as a number is kept as its decimal text", () => {
  const order = parseShopifyOrder({ ...SAMPLE, total_tax: 11.94 });
  assert.equal(order?.totalTax, "11.94");
});

test("a payload with no usable order id, or that is not an object, is refused", () => {
  assert.equal(parseShopifyOrder({ name: "#1" }), null);
  assert.equal(parseShopifyOrder({ ...SAMPLE, id: "abc" }), null);
  assert.equal(parseShopifyOrder(["not", "an", "order"]), null);
  assert.equal(parseShopifyOrder(null), null);
});

test("an order id sent as text is read the same way", () => {
  assert.equal(parseShopifyOrder({ ...SAMPLE, id: "450789469" })?.shopifyOrderId, "450789469");
});

test("discount codes and note attributes that are not lists become null, and entries without a name are skipped", () => {
  const order = parseShopifyOrder({
    ...SAMPLE,
    discount_codes: "SPRING30",
    note_attributes: [{ value: "no name" }, { name: "dm_keyword", value: "KQ7XW2MN" }],
  });
  assert.equal(order?.discountCodes, null);
  assert.deepEqual(order?.noteAttributes, [{ name: "dm_keyword", value: "KQ7XW2MN" }]);
});

test("the UTM values come from the query of a relative landing site", () => {
  assert.deepEqual(utmOfLandingSite("/?source=abc&utm_content=mr0123456789ab&utm_campaign=meridian_brand_1"), {
    utmContent: "mr0123456789ab",
    utmCampaign: "meridian_brand_1",
  });
  assert.deepEqual(utmOfLandingSite("https://shop.example.com/p/1?utm_content=mrAAAA"), { utmContent: "mrAAAA", utmCampaign: null });
});

test("a landing site with no UTM value, no landing site, or a value longer than 200 characters gives null", () => {
  assert.deepEqual(utmOfLandingSite("/"), { utmContent: null, utmCampaign: null });
  assert.deepEqual(utmOfLandingSite(null), { utmContent: null, utmCampaign: null });
  assert.deepEqual(utmOfLandingSite(`/?utm_content=${"x".repeat(201)}`), { utmContent: null, utmCampaign: null });
});
