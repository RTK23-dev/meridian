import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "../learning/store.ts";
import {
  clusterAdsByEmbeddings,
  clusterStoredCreativeDna,
  trendReport,
  type EmbeddingAdItem,
} from "./trends.ts";

async function makeTestDb(): Promise<Sql> {
  const db = new PGlite({ extensions: { vector } });
  await db.waitReady;
  const dir = join(process.cwd(), "migrations");
  const names = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  await db.exec("create table if not exists _migrations (name text primary key)");
  for (const name of names) {
    const text = await readFile(join(dir, name), "utf8");
    await db.exec(text);
  }
  const sql = (async <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? "";
    for (let index = 0; index < values.length; index += 1) text += `$${index + 1}${strings[index + 1] ?? ""}`;
    const result = await db.query<T>(text, values);
    return result.rows;
  }) as Sql;
  sql.query = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await db.query<T>(text, params)).rows;
  return sql;
}

test("Trends Step 4: confirms clustering uses Step 2 pgvector embeddings", () => {
  // Create 2 clusters: Cluster A (base unit vector 0), Cluster B (base unit vector 1)
  const vecA1 = new Array(384).fill(0);
  vecA1[0] = 1.0;
  vecA1[1] = 0.1;

  const vecA2 = new Array(384).fill(0);
  vecA2[0] = 0.98;
  vecA2[1] = 0.15;

  const vecB1 = new Array(384).fill(0);
  vecB1[50] = 1.0;
  vecB1[51] = 0.05;

  const ads: EmbeddingAdItem[] = [
    {
      id: "ad-1",
      researchAdId: "r-1",
      advertiser: "Brand A",
      capturedAt: "2026-10-06",
      niche: "skincare",
      conceptLabel: "asmr unboxing",
      embedding: vecA1,
    },
    {
      id: "ad-2",
      researchAdId: "r-2",
      advertiser: "Brand B",
      capturedAt: "2026-10-06",
      niche: "skincare",
      conceptLabel: "asmr unboxing",
      embedding: vecA2,
    },
    {
      id: "ad-3",
      researchAdId: "r-3",
      advertiser: "Brand C",
      capturedAt: "2026-10-06",
      niche: "skincare",
      conceptLabel: "dermatologist reaction",
      embedding: vecB1,
    },
  ];

  const clusters = clusterAdsByEmbeddings(ads, { minSimilarity: 0.85 });
  assert.equal(clusters.length, 2);

  const asmrCluster = clusters.find((c) => c.adIds.includes("ad-1"));
  assert.ok(asmrCluster);
  assert.ok(asmrCluster.adIds.includes("ad-2"));
  assert.equal(asmrCluster.adIds.length, 2);

  const dermCluster = clusters.find((c) => c.adIds.includes("ad-3"));
  assert.ok(dermCluster);
  assert.equal(dermCluster.adIds.length, 1);
});

test("Trends Step 4: confirms rising, peaking, and fading momentum come strictly from real week-over-week counts", () => {
  const report = trendReport({
    thisWeek: "2026-10-06",
    prevWeek: "2026-09-29",
    brandConcepts: ["existing brand format"],
    ads: [
      // Concept 1 (Rising): 3 ads this week (from 2 advertisers) vs 1 ad last week (ratio 3.0, new advertisers = 2)
      { id: "r1", concept: "split-screen comparison", advertiser: "Brand 1", week: "2026-10-06", niche: "supplements" },
      { id: "r2", concept: "split-screen comparison", advertiser: "Brand 2", week: "2026-10-06", niche: "supplements" },
      { id: "r3", concept: "split-screen comparison", advertiser: "Brand 1", week: "2026-10-06", niche: "supplements" },
      { id: "r4", concept: "split-screen comparison", advertiser: "Brand 3", week: "2026-09-29", niche: "supplements" },

      // Concept 2 (Peaking): 6 ads this week vs 6 ads last week (ratio 1.0, high volume)
      ...Array(6).fill(0).map((_, i) => ({ id: `p_cur_${i}`, concept: "ugc testimonial", advertiser: `Brand ${i}`, week: "2026-10-06", niche: "supplements" })),
      ...Array(6).fill(0).map((_, i) => ({ id: `p_prev_${i}`, concept: "ugc testimonial", advertiser: `Brand ${i}`, week: "2026-09-29", niche: "supplements" })),

      // Concept 3 (Fading): 1 ad this week vs 4 ads last week (ratio 0.25 <= 0.7)
      { id: "f1", concept: "green screen commentary", advertiser: "Brand 4", week: "2026-10-06", niche: "supplements" },
      { id: "f2", concept: "green screen commentary", advertiser: "Brand 4", week: "2026-09-29", niche: "supplements" },
      { id: "f3", concept: "green screen commentary", advertiser: "Brand 5", week: "2026-09-29", niche: "supplements" },
      { id: "f4", concept: "green screen commentary", advertiser: "Brand 6", week: "2026-09-29", niche: "supplements" },
      { id: "f5", concept: "green screen commentary", advertiser: "Brand 7", week: "2026-09-29", niche: "supplements" },
    ],
  });

  const rising = report.find((c) => c.concept === "split-screen comparison");
  assert.ok(rising);
  assert.equal(rising.momentum, "rising");
  assert.equal(rising.adsThisWeek, 3);
  assert.equal(rising.adsPrevWeek, 1);
  assert.equal(rising.newAdvertisers, 2);

  const peaking = report.find((c) => c.concept === "ugc testimonial");
  assert.ok(peaking);
  assert.equal(peaking.momentum, "peaking");
  assert.equal(peaking.adsThisWeek, 6);
  assert.equal(peaking.adsPrevWeek, 6);

  const fading = report.find((c) => c.concept === "green screen commentary");
  assert.ok(fading);
  assert.equal(fading.momentum, "fading");
  assert.equal(fading.adsThisWeek, 1);
  assert.equal(fading.adsPrevWeek, 4);
});

test("Trends Step 4: clusterStoredCreativeDna groups database rows by pgvector embeddings", async () => {
  const sql = await makeTestDb();
  const org = "org-trend-db";
  const brand = "brand-trend-db";
  await sql`insert into organizations (id, name, slug, created_by) values (${org}, 'Org', 'org-tr', 'user')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brand}, ${org}, 'Brand', 'user')`;

  // Create two ads with similar embeddings and one with distinct embedding
  const v1 = new Array(384).fill(0);
  v1[0] = 0.99;
  const v2 = new Array(384).fill(0);
  v2[0] = 0.95;
  const v3 = new Array(384).fill(0);
  v3[10] = 0.99;

  await sql`
    insert into creative_dna (id, organization_id, brand_id, research_ad_id, schema_version, record, embedding)
    values
      ('dna-1', ${org}, ${brand}, 'ad-1', 'meridian.creative-dna.v2', '{"format":{"value":"ugc"}}', ${`[${v1.join(",")}]`}),
      ('dna-2', ${org}, ${brand}, 'ad-2', 'meridian.creative-dna.v2', '{"format":{"value":"ugc"}}', ${`[${v2.join(",")}]`}),
      ('dna-3', ${org}, ${brand}, 'ad-3', 'meridian.creative-dna.v2', '{"format":{"value":"demo"}}', ${`[${v3.join(",")}]`})
  `;

  const clusters = await clusterStoredCreativeDna(sql, { organizationId: org, brandId: brand, minSimilarity: 0.85 });
  assert.equal(clusters.length, 2);
  const clusterWithTwo = clusters.find((c) => c.adIds.length === 2);
  assert.ok(clusterWithTwo);
  assert.ok(clusterWithTwo.adIds.includes("dna-1"));
  assert.ok(clusterWithTwo.adIds.includes("dna-2"));
});
