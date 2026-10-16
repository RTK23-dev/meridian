import assert from "node:assert/strict";
import test from "node:test";
import { matchOrderToReel, signalsOf, type ReelLink } from "./attribution.ts";
import { parseShopifyOrder } from "./order.ts";

const LINKS: ReelLink[] = [
  { creativeId: "cr_a", utmContent: "mrAAAA", dmKeyword: "KQ7XW2MN" },
  { creativeId: "cr_b", utmContent: "mrBBBB", dmKeyword: "HT4PZ9CD" },
];

test("an order whose utm_content is one reel's link matches that reel by the utm rule", () => {
  const match = matchOrderToReel({ utmContent: "mrBBBB", discountCodes: [], noteKeywords: [] }, LINKS);
  assert.deepEqual(match, { creativeId: "cr_b", rule: "utm_content" });
});

test("the utm rule is checked before the keyword, so a conflicting keyword does not move the order", () => {
  const match = matchOrderToReel({ utmContent: "mrAAAA", discountCodes: ["HT4PZ9CD"], noteKeywords: [] }, LINKS);
  assert.deepEqual(match, { creativeId: "cr_a", rule: "utm_content" });
});

test("a discount code equal to a DM keyword matches by the keyword rule, ignoring case and spaces", () => {
  const match = matchOrderToReel({ utmContent: null, discountCodes: [" kq7xw2mn "], noteKeywords: [] }, LINKS);
  assert.deepEqual(match, { creativeId: "cr_a", rule: "dm_keyword" });
});

test("a note attribute keyword matches by the keyword rule", () => {
  const match = matchOrderToReel({ utmContent: null, discountCodes: [], noteKeywords: ["ht4pz9cd"] }, LINKS);
  assert.deepEqual(match, { creativeId: "cr_b", rule: "dm_keyword" });
});

test("two reels answering to one utm_content is a conflict, so the order is unmatched", () => {
  const clash: ReelLink[] = [
    { creativeId: "cr_a", utmContent: "mrSAME", dmKeyword: "AAAAAAAA" },
    { creativeId: "cr_b", utmContent: "mrSAME", dmKeyword: "BBBBBBBB" },
  ];
  assert.equal(matchOrderToReel({ utmContent: "mrSAME", discountCodes: [], noteKeywords: [] }, clash), null);
});

test("codes that point at two different reels, or one keyword held by two reels, are unmatched, never guessed", () => {
  assert.equal(matchOrderToReel({ utmContent: null, discountCodes: ["KQ7XW2MN", "HT4PZ9CD"], noteKeywords: [] }, LINKS), null);
  const shared: ReelLink[] = [
    { creativeId: "cr_a", utmContent: "mrAAAA", dmKeyword: "KQ7XW2MN" },
    { creativeId: "cr_b", utmContent: "mrBBBB", dmKeyword: "KQ7XW2MN" },
  ];
  assert.equal(matchOrderToReel({ utmContent: null, discountCodes: ["KQ7XW2MN"], noteKeywords: [] }, shared), null);
});

test("an order with no utm value and no keyword, or with an unknown one, is unmatched", () => {
  assert.equal(matchOrderToReel({ utmContent: null, discountCodes: [], noteKeywords: [] }, LINKS), null);
  assert.equal(matchOrderToReel({ utmContent: "mrNONE", discountCodes: ["ZZZZZZZZ"], noteKeywords: [] }, LINKS), null);
  assert.equal(matchOrderToReel({ utmContent: "mrNONE", discountCodes: [], noteKeywords: [] }, []), null);
});

test("the signals read a landing site's utm and only the note attributes named as keywords", () => {
  const order = parseShopifyOrder({
    id: 1,
    landing_site: "/?utm_content=mrBBBB",
    discount_codes: [{ code: "HT4PZ9CD" }],
    note_attributes: [
      { name: "DM_KEYWORD", value: "KQ7XW2MN" },
      { name: "gift_message", value: "HT4PZ9CD" },
    ],
  });
  assert.ok(order);
  assert.deepEqual(signalsOf(order), { utmContent: "mrBBBB", discountCodes: ["HT4PZ9CD"], noteKeywords: ["KQ7XW2MN"] });
});
