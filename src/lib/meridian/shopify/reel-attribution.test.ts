import assert from "node:assert/strict";
import test from "node:test";
import type { Sql } from "../learning/store.ts";
import {
  keywordFor,
  reelAttributionFor,
  reelLinkUrl,
  utmCampaignFor,
  utmContentFor,
} from "./reel-attribution.ts";

const ORG = "org_fixture";
const BRAND = "brand_fixture";
const OTHER_BRAND = "brand_other";
const CREATIVE = "cr_reel_one";
const OTHER_CREATIVE = "cr_reel_two";
const KEYWORD_SHAPE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

test("a DM keyword is 8 characters from the unambiguous alphabet, and the same for the same reel", () => {
  const first = keywordFor(ORG, CREATIVE, 0);
  assert.match(first, KEYWORD_SHAPE);
  assert.equal(keywordFor(ORG, CREATIVE, 0), first);
  assert.notEqual(keywordFor(ORG, CREATIVE, 1), first, "the next candidate is a different keyword");
  assert.notEqual(keywordFor(ORG, OTHER_CREATIVE, 0), first, "another reel gets another keyword");
  assert.notEqual(keywordFor("org_other", CREATIVE, 0), first, "another workspace gets another keyword");
});

test("the utm_content is mr and twelve hex characters, the same for the same reel", () => {
  const content = utmContentFor(ORG, CREATIVE);
  assert.match(content, /^mr[0-9a-f]{12}$/);
  assert.equal(utmContentFor(ORG, CREATIVE), content);
  assert.notEqual(utmContentFor(ORG, OTHER_CREATIVE), content);
});

test("the utm_campaign is lowercase letters, digits and underscores", () => {
  assert.equal(utmCampaignFor("Brand-ABC.1"), "meridian_brand_abc_1");
});

test("the link keeps the product page's own query and sets the four UTM values", () => {
  const link = reelLinkUrl("https://shop.example.com/products/x?ref=blog", {
    utmSource: "meridian",
    utmMedium: "reel",
    utmCampaign: "meridian_brand_fixture",
    utmContent: "mr0123456789ab",
  });
  assert.ok(link);
  const url = new URL(link);
  assert.equal(url.searchParams.get("ref"), "blog");
  assert.equal(url.searchParams.get("utm_source"), "meridian");
  assert.equal(url.searchParams.get("utm_medium"), "reel");
  assert.equal(url.searchParams.get("utm_campaign"), "meridian_brand_fixture");
  assert.equal(url.searchParams.get("utm_content"), "mr0123456789ab");
});

test("a destination that is not an http or https URL makes no link", () => {
  const params = { utmSource: "meridian", utmMedium: "reel", utmCampaign: "c", utmContent: "mr0" };
  assert.equal(reelLinkUrl("javascript:alert(1)", params), null);
  assert.equal(reelLinkUrl("not a url", params), null);
});

type AttributionRow = {
  creative_id: string;
  organization_id: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  dm_keyword: string;
  destination_url: string | null;
  link_url: string | null;
};

/**
 * An in-memory stand-in for the statements reelAttributionFor runs. It keeps the unique rules of migration 0092 (one row per
 * creative, one per utm_content, one per keyword) and answers the reads by statement text.
 */
function fakeAttributionDb(input: { creatives: Array<{ id: string; organization_id: string; brand_id: string }>; productUrl: string | null }) {
  const rows: AttributionRow[] = [];
  const statement = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").toLowerCase();
    if (text.includes("from creative_records")) {
      const [id, organizationId, brandId] = values as string[];
      return input.creatives.some((row) => row.id === id && row.organization_id === organizationId && row.brand_id === brandId)
        ? [{ id }]
        : [];
    }
    if (text.includes("from products")) {
      const [brandId] = values as string[];
      return brandId === BRAND && input.productUrl ? [{ url: input.productUrl }] : [];
    }
    if (text.includes("dm_keyword = ?")) {
      const [organizationId, keyword] = values as string[];
      return rows.some((row) => row.organization_id === organizationId && row.dm_keyword === keyword) ? [{ id: "taken" }] : [];
    }
    if (text.includes("from reel_attributions where organization_id = ? and creative_id = ?")) {
      const [organizationId, creativeId] = values as string[];
      const row = rows.find((item) => item.organization_id === organizationId && item.creative_id === creativeId);
      return row ? [{ ...row }] : [];
    }
    if (text.includes("insert into reel_attributions")) {
      assert.match(text, /on conflict do nothing returning id/);
      // Positions follow the insert: 0 id, 1 organization, 2 brand, 3 creative, 4 utm_campaign, 5 utm_content, 6 dm_keyword,
      // 7 destination, 8 link.
      const [, organizationId, , creativeId, utmCampaign, utmContent, dmKeyword, destination, linkUrl] = values as Array<string | null>;
      const clash = rows.some(
        (row) =>
          row.organization_id === organizationId &&
          (row.creative_id === creativeId || row.utm_content === utmContent || row.dm_keyword === dmKeyword),
      );
      if (clash) return [];
      rows.push({
        creative_id: creativeId ?? "",
        organization_id: organizationId ?? "",
        utm_source: "meridian",
        utm_medium: "reel",
        utm_campaign: utmCampaign ?? "",
        utm_content: utmContent ?? "",
        dm_keyword: dmKeyword ?? "",
        destination_url: destination,
        link_url: linkUrl,
      });
      return [{ id: "row" }];
    }
    throw new Error(`The fake database does not answer this statement: ${text}`);
  };
  return { sql: statement as unknown as Sql, rows };
}

const CREATIVES = [
  { id: CREATIVE, organization_id: ORG, brand_id: BRAND },
  { id: OTHER_CREATIVE, organization_id: ORG, brand_id: BRAND },
];

test("a reel of another brand gets no attribution, and nothing is stored", async () => {
  const db = fakeAttributionDb({ creatives: CREATIVES, productUrl: "https://shop.example.com/p" });
  const record = await reelAttributionFor(db.sql, { organizationId: ORG, brandId: OTHER_BRAND, creativeId: CREATIVE });
  assert.equal(record, null);
  assert.equal(db.rows.length, 0);
});

test("the first call creates the keyword and the link, and a second call returns the same values", async () => {
  const db = fakeAttributionDb({ creatives: CREATIVES, productUrl: "https://shop.example.com/p/1?ref=abc" });
  const first = await reelAttributionFor(db.sql, { organizationId: ORG, brandId: BRAND, creativeId: CREATIVE });
  assert.ok(first);
  assert.match(first.dmKeyword, KEYWORD_SHAPE);
  assert.equal(first.dmKeyword, keywordFor(ORG, CREATIVE, 0));
  assert.equal(first.utmContent, utmContentFor(ORG, CREATIVE));
  assert.equal(first.reason, null);
  assert.ok(first.linkUrl);
  assert.equal(new URL(first.linkUrl).searchParams.get("utm_content"), first.utmContent);

  const second = await reelAttributionFor(db.sql, { organizationId: ORG, brandId: BRAND, creativeId: CREATIVE });
  assert.deepEqual(second, first);
  assert.equal(db.rows.length, 1);
});

test("a brand with no product URL gets a keyword and no link, with the reason stated", async () => {
  const db = fakeAttributionDb({ creatives: CREATIVES, productUrl: null });
  const record = await reelAttributionFor(db.sql, { organizationId: ORG, brandId: BRAND, creativeId: CREATIVE });
  assert.ok(record);
  assert.equal(record.linkUrl, null);
  assert.equal(record.destinationUrl, null);
  assert.match(record.reason ?? "", /no product URL/);
});

test("a keyword already held by another reel is skipped, and the next candidate is used", async () => {
  const db = fakeAttributionDb({ creatives: CREATIVES, productUrl: "https://shop.example.com/p" });
  // The other reel already holds this reel's first candidate.
  db.rows.push({
    creative_id: OTHER_CREATIVE,
    organization_id: ORG,
    utm_source: "meridian",
    utm_medium: "reel",
    utm_campaign: "meridian_brand_fixture",
    utm_content: utmContentFor(ORG, OTHER_CREATIVE),
    dm_keyword: keywordFor(ORG, CREATIVE, 0),
    destination_url: null,
    link_url: null,
  });
  const record = await reelAttributionFor(db.sql, { organizationId: ORG, brandId: BRAND, creativeId: CREATIVE });
  assert.ok(record);
  assert.equal(record.dmKeyword, keywordFor(ORG, CREATIVE, 1));
  assert.notEqual(record.dmKeyword, keywordFor(ORG, CREATIVE, 0));
});
