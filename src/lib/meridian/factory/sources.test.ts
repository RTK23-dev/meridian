import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "../learning/store.ts";
import {
  BulkUploadSourceAdapter,
  SensorTowerSourceAdapter,
} from "./sources.ts";
import { recheckAdTimelines } from "./timeline.ts";
import { backtestWinnerScore, runWinnerScoreBacktest } from "./winner-score.ts";

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

test("Sources: Bulk upload parses folder of video files and CSV of links", () => {
  const adapter = new BulkUploadSourceAdapter();

  // 1. Folder parsing
  const folderAds = adapter.parseFolder([
    {
      filename: "competitor_ad_1.mp4",
      bytes: new Uint8Array([1, 2, 3, 4]),
      advertiser: "Glow Skin Co",
      copy: "Best serum for wrinkles",
      platforms: ["instagram"],
      durationMs: 15000,
    },
  ]);

  assert.equal(folderAds.length, 1);
  assert.equal(folderAds[0]?.advertiser, "Glow Skin Co");
  assert.equal(folderAds[0]?.copy, "Best serum for wrinkles");
  assert.equal(folderAds[0]?.durationMs, 15000);
  assert.deepEqual(folderAds[0]?.platforms, ["instagram"]);
  assert.equal(folderAds[0]?.videoBytes?.byteLength, 4);

  // 2. CSV parsing
  const csvContent = `url,advertiser,copy,platforms,duration_ms
https://cdn.example.com/ad1.mp4,Acme Health,Boost your energy,facebook;instagram,12000
https://cdn.example.com/ad2.mp4,Acme Health,Sleep better tonight,tiktok,18000
invalid-url-line,No Url,Ignore me,,
`;

  const csvAds = adapter.parseCsvOfLinks(csvContent);
  assert.equal(csvAds.length, 2);
  assert.equal(csvAds[0]?.originalUrl, "https://cdn.example.com/ad1.mp4");
  assert.equal(csvAds[0]?.advertiser, "Acme Health");
  assert.deepEqual(csvAds[0]?.platforms, ["facebook", "instagram"]);
  assert.equal(csvAds[0]?.durationMs, 12000);

  assert.equal(csvAds[1]?.originalUrl, "https://cdn.example.com/ad2.mp4");
  assert.deepEqual(csvAds[1]?.platforms, ["tiktok"]);
});

test("Sources: Sensor Tower adapter returns NOT_CONNECTED until key is configured", async () => {
  const adapter = new SensorTowerSourceAdapter();

  // When key is missing:
  const disconnected = await adapter.fetchAds({}, { SENSOR_TOWER_API_KEY: "" });
  assert.equal(disconnected.status, "NOT_CONNECTED");
  assert.match((disconnected as { reason: string }).reason, /SENSOR_TOWER_API_KEY is not set/);

  // When key is set:
  const connected = await adapter.fetchAds({}, { SENSOR_TOWER_API_KEY: "st_live_key_123" });
  assert.equal(connected.status, "connected");
});

test("Timelines: daily re-check job updates days_running and recalculates Winner Score", async () => {
  const sql = await makeTestDb();
  const org = "org-timeline-recheck";
  const brand = "brand-timeline-recheck";
  await sql`insert into organizations (id, name, slug, created_by) values (${org}, 'Org', 'org-time', 'user')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brand}, ${org}, 'Brand', 'user')`;

  // Seed timeline with first_seen 10 days ago
  const firstSeen = new Date(Date.now() - 10 * 86_400_000).toISOString();
  const timelineId = "timeline-1";
  await sql`
    insert into ad_timelines (
      id, organization_id, brand_id, first_seen, last_seen, still_running, days_running,
      sibling_variants, platforms, countries, winner_score
    ) values (
      ${timelineId}, ${org}, ${brand}, ${firstSeen}, ${firstSeen}, true, 0,
      3, '["facebook","instagram"]', '["US","CA"]', 0.2
    )
  `;

  // Run daily timeline re-check
  const { recheckedCount } = await recheckAdTimelines(sql, {
    organizationId: org,
    brandId: brand,
  });
  assert.equal(recheckedCount, 1);

  const updated = await sql<{ days_running: number; winner_score: number; evidence: string }>`
    select days_running, winner_score, evidence
    from ad_timelines
    where id = ${timelineId}
  `;

  assert.ok(updated[0]);
  assert.ok(updated[0].days_running >= 9 && updated[0].days_running <= 11);
  assert.ok(updated[0].winner_score > 0.2); // Score increased due to survival days
  assert.match(updated[0].evidence, /live \d+ days/);
});

test("Winner Score: backtest calculates top 20% vs random baseline and reports honestly", () => {
  // Synthesize 20 ads: 10 with high scores that survived >= 30 days, 10 low scores that died
  const rows = [
    ...Array(4).fill(0).map(() => ({ score: 0.85, stillLiveAfter30Days: true })),
    ...Array(6).fill(0).map(() => ({ score: 0.65, stillLiveAfter30Days: true })),
    ...Array(10).fill(0).map(() => ({ score: 0.25, stillLiveAfter30Days: false })),
  ];

  const result = backtestWinnerScore(rows);
  assert.equal(result.n, 20);
  assert.equal(result.top20HitRate, 1.0); // Top 4/4 (20%) all survived 30 days
  assert.equal(result.randomHitRate, 0.5); // 10/20 overall survived 30 days
  assert.equal(result.lift, 2.0); // 2.0x lift over chance
});

test("Winner Score: backtest reports insufficient data when fewer than 10 tracked ads exist", async () => {
  const sql = await makeTestDb();
  const result = await runWinnerScoreBacktest(sql, {});
  assert.equal(result.top20HitRate, null);
  assert.equal(result.randomHitRate, null);
  assert.equal(result.lift, null);
  assert.match(result.report, /Insufficient historical data/);
});
