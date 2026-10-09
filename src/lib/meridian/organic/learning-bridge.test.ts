import assert from "node:assert/strict";
import test from "node:test";
import { ingestOrganicContentForLearning } from "./learning-bridge.ts";
import { scrapeAndLearnOrganicContent } from "./pipeline.ts";
import type { Sql } from "./creators.ts";

function createMockSql() {
  const store = {
    creative_records: [] as Record<string, unknown>[],
    organic_posts: [] as Record<string, unknown>[],
    organic_observations: [] as Record<string, unknown>[],
    performance_observations: [] as Record<string, unknown>[],
    learned_patterns: [] as Record<string, unknown>[],
  };

  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ""), "");

    if (query.includes("insert into creative_records")) {
      store.creative_records.push({
        id: values[0],
        organization_id: values[1],
        brand_id: values[2],
        origin: "own",
        source_url: values[3],
        title: values[4],
        raw_text: values[5],
        angle: values[6],
        hook_type: values[7],
        format: values[8],
        proof_type: values[9],
        visual_style: values[10],
        platform: values[11],
      });
      return [];
    }

    if (query.includes("insert into organic_posts")) {
      store.organic_posts.push({
        id: values[0],
        organization_id: values[1],
        brand_id: values[2],
        creative_id: values[3],
        platform: values[4],
        caption: values[5],
      });
      return [];
    }

    if (query.includes("insert into organic_observations")) {
      store.organic_observations.push({
        id: values[0],
        organization_id: values[1],
        brand_id: values[2],
        organic_post_id: values[3],
        creative_id: values[4],
        platform: values[5],
        views: values[6],
        three_second_views: values[7],
        completion_rate: values[8],
        shares: values[9],
        likes: values[10],
        comments: values[11],
        saves: values[12],
      });
      return [];
    }

    if (query.includes("select id, organization_id, brand_id, origin, angle, hook_type, format")) {
      return store.creative_records;
    }

    if (query.includes("select creative_id, organization_id, brand_id, impressions, clicks, conversions")) {
      return store.performance_observations;
    }

    if (query.includes("select creative_id, organization_id, brand_id, views, three_second_views, completion_rate, shares")) {
      return store.organic_observations;
    }

    if (query.includes("delete from learned_patterns")) {
      store.learned_patterns = [];
      return [];
    }

    if (query.includes("insert into learned_patterns")) {
      store.learned_patterns.push({
        id: values[0],
        organization_id: values[1],
        brand_id: values[2],
        attribute: values[3],
        value: values[4],
        metric: values[5],
        lift: values[6],
        sample_size: values[7],
        baseline: values[8],
        observed: values[9],
        impressions: values[10],
        summary: values[11],
        state: values[12],
      });
      return [];
    }

    return [];
  }) as unknown as Sql;

  return { sql, store };
}

test("ingestOrganicContentForLearning creates creative record, organic observation, and triggers learning", async () => {
  const { sql, store } = createMockSql();

  const orgId = "org_test";
  const brandId = "brand_test";

  const result = await ingestOrganicContentForLearning(sql, {
    organizationId: orgId,
    brandId,
    platform: "tiktok",
    sourceUrl: "https://www.tiktok.com/@creator/video/123456789",
    title: "Viral Skincare Routine Hack",
    rawText: "Stop making this huge mistake in your night routine! #skincare",
    angle: "pain_point",
    hookType: "bold_claim",
    format: "demo",
    metrics: {
      views: 50000,
      threeSecondViews: 32000,
      completionRate: 0.42,
      shares: 1200,
      likes: 4500,
      comments: 310,
    },
    commentsList: [
      { text: "Where can I buy this?", likes: 45 },
      { text: "Too expensive for me", likes: 12 },
      { text: "Can confirm this actually works!", likes: 88 },
    ],
  });

  assert.ok(result.creativeId.startsWith("cr_org_"));
  assert.ok(result.observationId.startsWith("org_obs_"));
  assert.equal(store.creative_records.length, 1);
  assert.equal(store.creative_records[0].angle, "pain_point");
  assert.equal(store.creative_records[0].hook_type, "bold_claim");
  assert.equal(store.creative_records[0].format, "demo");

  assert.equal(store.organic_observations.length, 1);
  assert.equal(store.organic_observations[0].views, 50000);
  assert.equal(store.organic_observations[0].three_second_views, 32000);
  assert.equal(store.organic_observations[0].shares, 1200);

  // Comment intents analyzed
  assert.equal(result.analyzedComments?.length, 3);
  const desire = result.analyzedComments?.find((c) => c.intent === "desire");
  assert.ok(desire);
  assert.equal(desire?.text, "Where can I buy this?");
});

test("scrapeAndLearnOrganicContent handles social URL, infers traits, and feeds learning", async () => {
  const { sql, store } = createMockSql();

  const res = await scrapeAndLearnOrganicContent(sql, {
    organizationId: "org_1",
    brandId: "brand_1",
    url: "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    estimatedViews: 15000,
  });

  assert.equal(res.scraped.platform, "youtube");
  assert.equal(res.scraped.externalId, "dQw4w9WgXcQ");
  assert.equal(store.creative_records.length, 1);
  assert.equal(store.organic_observations.length, 1);
  assert.equal(store.organic_observations[0].views, 15000);
});
