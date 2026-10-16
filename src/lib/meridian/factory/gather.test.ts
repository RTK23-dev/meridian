import assert from "node:assert/strict";
import test from "node:test";
import { executeFactoryJob } from "./worker.ts";
import {
  factoryRunSourcesFor,
  gatheredSummary,
  GATHER_PLATFORM_ADAPTERS,
  isSocialUrl,
  itemFromSocialPost,
  platformAdaptersFor,
  seedsFrom,
  type GatheredSource,
} from "./gather.ts";
import {
  FACTORY_TEST_BRAND,
  FACTORY_TEST_ORG,
  FACTORY_TEST_RUN,
  FIXTURE_BRAND_WEBSITE,
  FIXTURE_TIKTOK_LINK,
  factoryJob,
  factoryRunRow,
  fixtureGatherDeps,
  makeFactoryTestSql,
  seedConfirmedCompetitor,
  seedFactoryRun,
  seedJobRow,
  withFixtureFetch,
} from "../testing/factory-fixtures.ts";
import type { Sql } from "../learning/store.ts";

const DISCOVER_JOB = "job-discover-gather";
const MANUAL = { automation: "manual" };

type SourceRow = { state: string; reason: string; items: number };

async function sourceRows(sql: Sql): Promise<Map<string, SourceRow>> {
  const rows = await sql<{ source: string; state: string; reason: string; items: number }>`
    select source, state, reason, items from factory_run_sources where run_id = ${FACTORY_TEST_RUN}
  `;
  return new Map(rows.map((row) => [row.source, { state: row.state, reason: row.reason, items: Number(row.items) }]));
}

/** Runs discover for the test run with the given fixtures, inside the no-live-request guard. */
async function runDiscover(sql: Sql, deps: Parameters<typeof fixtureGatherDeps>[0]): Promise<string> {
  return withFixtureFetch(() =>
    executeFactoryJob(sql, factoryJob("factory.discover", DISCOVER_JOB), { runId: FACTORY_TEST_RUN }, fixtureGatherDeps(deps)),
  );
}

test("discover gathers the crawler, the social scraper and the Ad Library from fixtures, and records each source's state", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: MANUAL, level: 0, website: FIXTURE_BRAND_WEBSITE, country: "us" });
  await seedConfirmedCompetitor(sql, { id: "competitor-1", name: "Rival", website: FIXTURE_TIKTOK_LINK });
  await seedJobRow(sql, DISCOVER_JOB, "factory.discover");

  const result = await runDiscover(sql, { metaToken: "fixture-token" });
  assert.equal(result, "gathered:ok=4;not_connected=11;failed=1");

  const rows = await sourceRows(sql);
  assert.equal(rows.size, 16, "every source the run covers has one recorded state, the Instagram volume source included");

  // The crawler read the brand page and its product card from the fixture page.
  assert.equal(rows.get("crawler")?.state, "ok");
  assert.equal(rows.get("crawler")?.items, 2);
  // The social scraper read the competitor's TikTok link through the oEmbed fixture.
  assert.equal(rows.get("social_scraper")?.state, "ok");
  assert.equal(rows.get("social_scraper")?.items, 1);
  // The Ad Library collector stored both fixture ads.
  assert.equal(rows.get("meta_ad_library")?.state, "ok");
  assert.equal(rows.get("meta_ad_library")?.items, 2);

  // A source without a key is shown as not connected, with its reason.
  assert.equal(rows.get("tiktok")?.state, "not_connected");
  assert.match(rows.get("tiktok")?.reason ?? "", /No TikTok key is saved/);
  // A key is saved and the search returned nothing: it ran, with no items.
  assert.equal(rows.get("youtube")?.state, "ok");
  assert.equal(rows.get("youtube")?.items, 0);
  // A key is saved and the search failed: the error is recorded.
  assert.equal(rows.get("reddit")?.state, "failed");
  assert.match(rows.get("reddit")?.reason ?? "", /HTTP 503/);
  // No upload is stored, so the upload source is not connected.
  assert.equal(rows.get("upload")?.state, "not_connected");

  // The run continues after gathering.
  const run = await factoryRunRow(sql);
  assert.equal(run.status, "running");
  assert.equal(run.current_stage, "factory.discover");
});

test("gathered items land in the existing evidence tables, and the ads reach grading with their stop time and countries", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: MANUAL, level: 0, website: FIXTURE_BRAND_WEBSITE, country: "us" });
  await seedConfirmedCompetitor(sql, { id: "competitor-1", name: "Rival", website: FIXTURE_TIKTOK_LINK });
  await seedJobRow(sql, DISCOVER_JOB, "factory.discover");
  await runDiscover(sql, { metaToken: "fixture-token" });

  const ads = await sql<{ external_id: string; source_metrics: string }>`
    select external_id, source_metrics from research_ads
    where organization_id = ${FACTORY_TEST_ORG} and brand_id = ${FACTORY_TEST_BRAND}
    order by external_id asc
  `;
  assert.equal(ads.length, 2);
  const stopped = JSON.parse(ads[0]?.source_metrics ?? "{}") as { stoppedAt: string | null; countries: string[] };
  assert.equal(stopped.stoppedAt, "2026-09-20T07:00:00+0000");
  assert.deepEqual(stopped.countries, ["US", "CA"]);
  const delivering = JSON.parse(ads[1]?.source_metrics ?? "{}") as { stoppedAt: string | null };
  assert.equal(delivering.stoppedAt, null, "an ad Meta still reports as delivering has no stop time");

  const collection = await sql<{ status: string; collected_count: number }>`
    select status, collected_count from research_collection_runs where job_id = ${DISCOVER_JOB}
  `;
  assert.equal(collection[0]?.status, "succeeded");
  assert.equal(Number(collection[0]?.collected_count), 2);

  // Discovered items belong to the discovery run the gather opened, not to the Factory run, so the query is by tenant and platform.
  const posts = await sql<{ n: number }>`
    select count(*)::int as n from discovered_items
    where organization_id = ${FACTORY_TEST_ORG} and brand_id = ${FACTORY_TEST_BRAND} and source = 'tiktok'
  `;
  assert.equal(posts[0]?.n, 1, "the scraped post is a discovered item of the brand");

  const pageEvidence = await sql<{ n: number }>`
    select count(*)::int as n from discovered_page_evidence
    where organization_id = ${FACTORY_TEST_ORG} and brand_id = ${FACTORY_TEST_BRAND}
  `;
  assert.ok((pageEvidence[0]?.n ?? 0) >= 1, "the brand page's declared evidence is stored as page evidence");

  // Grading reads the Ad Library ads the gather stored, so each one gets a timeline.
  const graded = await executeFactoryJob(sql, factoryJob("factory.grade"), { runId: FACTORY_TEST_RUN });
  assert.equal(graded, "graded:2");
});

test("a source without a key is not connected, and the run continues with what it has", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: MANUAL, level: 0, website: FIXTURE_BRAND_WEBSITE, country: "us" });
  await seedConfirmedCompetitor(sql, { id: "competitor-1", name: "Rival", website: FIXTURE_TIKTOK_LINK });
  await seedJobRow(sql, DISCOVER_JOB, "factory.discover");

  const result = await runDiscover(sql, { metaToken: null });
  assert.equal(result, "gathered:ok=3;not_connected=12;failed=1");

  const rows = await sourceRows(sql);
  assert.equal(rows.get("meta_ad_library")?.state, "not_connected");
  assert.match(rows.get("meta_ad_library")?.reason ?? "", /META_AD_LIBRARY_TOKEN is not configured/);

  const ads = await sql<{ n: number }>`select count(*)::int as n from research_ads where brand_id = ${FACTORY_TEST_BRAND}`;
  assert.equal(ads[0]?.n, 0, "no ad is invented when the source is not connected");
  const collection = await sql<{ status: string }>`select status from research_collection_runs where job_id = ${DISCOVER_JOB}`;
  assert.equal(collection[0]?.status, "NOT_CONNECTED", "the collection is recorded as not connected");

  // The rest of the run goes on: the crawler and the social scraper still stored what they read.
  assert.equal(rows.get("crawler")?.state, "ok");
  const ingest = await executeFactoryJob(sql, factoryJob("factory.ingest"), { runId: FACTORY_TEST_RUN });
  assert.match(ingest, /^ingest:/);
  assert.equal((await factoryRunRow(sql)).status, "running");
});

test("a social scrape that fails is recorded as failed with its error, and the run continues", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: MANUAL, level: 0, website: FIXTURE_BRAND_WEBSITE, country: "us" });
  await seedConfirmedCompetitor(sql, { id: "competitor-1", name: "Rival", website: FIXTURE_TIKTOK_LINK });
  await seedJobRow(sql, DISCOVER_JOB, "factory.discover");

  await runDiscover(sql, {
    metaToken: "fixture-token",
    scrapeSocial: async (url) => ({
      platform: "tiktok",
      url,
      extractedAt: "2026-10-13T00:00:00.000Z",
      rawPayload: { error: "TikTok oEmbed returned HTTP 500." },
    }),
  });

  const rows = await sourceRows(sql);
  assert.equal(rows.get("social_scraper")?.state, "failed");
  assert.equal(rows.get("social_scraper")?.reason, "TikTok oEmbed returned HTTP 500.");
  assert.equal(rows.get("social_scraper")?.items, 0, "a failed read stores nothing");
  assert.equal(rows.get("meta_ad_library")?.state, "ok");
  assert.equal((await factoryRunRow(sql)).status, "running");
});

test("a brand with no saved website reports the crawler and the scraper as not connected, and still searches the niche", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: MANUAL, level: 0 });
  await seedJobRow(sql, DISCOVER_JOB, "factory.discover");

  await runDiscover(sql, { metaToken: "fixture-token" });

  const rows = await sourceRows(sql);
  assert.equal(rows.get("crawler")?.state, "not_connected");
  assert.match(rows.get("crawler")?.reason ?? "", /No public website is saved/);
  assert.equal(rows.get("social_scraper")?.state, "not_connected");
  assert.equal(rows.get("youtube")?.state, "ok", "the niche search still runs without a website");
});

test("the Factory board reads each recent run's source states", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: MANUAL, level: 0, website: FIXTURE_BRAND_WEBSITE, country: "us" });
  await seedJobRow(sql, DISCOVER_JOB, "factory.discover");
  await runDiscover(sql, { metaToken: "fixture-token" });

  const byRun = await factoryRunSourcesFor(sql, FACTORY_TEST_ORG, FACTORY_TEST_BRAND);
  const sources = byRun.get(FACTORY_TEST_RUN) ?? [];
  assert.equal(sources.length, 16);
  assert.ok(sources.some((row) => row.source === "meta_ad_library" && row.state === "ok" && row.items === 2));
  assert.ok(sources.every((row) => ["ok", "not_connected", "failed"].includes(row.state)));
});

test("discover refuses a run that is not in the brand it names", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: MANUAL, level: 0, website: FIXTURE_BRAND_WEBSITE, country: "us" });
  await seedJobRow(sql, DISCOVER_JOB, "factory.discover");
  await assert.rejects(
    withFixtureFetch(() =>
      executeFactoryJob(sql, factoryJob("factory.discover", DISCOVER_JOB, "brand-other"), { runId: FACTORY_TEST_RUN }, fixtureGatherDeps({ metaToken: "fixture-token" })),
    ),
    /not owned by this organization and brand/,
  );
  const rows = await sourceRows(sql);
  assert.equal(rows.size, 0, "nothing is gathered for a run the job does not own");
});

test("only a social link goes to the social scraper; any other saved website goes to the crawler, and a non-address is counted", () => {
  const seeds = seedsFrom(["glowskin.example", "https://glowskin.example/", FIXTURE_TIKTOK_LINK, "Glow Shop", ""]);
  assert.deepEqual(seeds.pages, ["https://glowskin.example/"]);
  assert.deepEqual(seeds.socialLinks, [FIXTURE_TIKTOK_LINK]);
  assert.equal(seeds.unreadable, 1, "a saved value that is not an address is counted, and the blank one is not");
});

test("a social host is recognised, and a look-alike host is not", () => {
  assert.equal(isSocialUrl("https://m.tiktok.com/@glowskinco/video/1"), true);
  assert.equal(isSocialUrl("https://x.com/glowskin/status/1"), true);
  assert.equal(isSocialUrl("https://nottiktok.com/@glowskinco"), false);
  assert.equal(isSocialUrl("https://glowskin.example/"), false);
  assert.equal(isSocialUrl("not a url"), false);
});

test("with no platform named the niche search covers every platform the Factory lists, and a named list is exactly that list", () => {
  assert.deepEqual(platformAdaptersFor([]), [...GATHER_PLATFORM_ADAPTERS]);
  assert.deepEqual(platformAdaptersFor(["instagram", "meta_ad_library", "instagram"]), ["instagram"]);
  assert.deepEqual(platformAdaptersFor(["meta_ad_library"]), [], "the Ad Library is gathered by its own collector");
});

test("a scraped post becomes an item whose metrics are observed only when the scraper reported them", () => {
  const post = { platform: "tiktok" as const, url: FIXTURE_TIKTOK_LINK, title: "Glow serum", views: 1200, extractedAt: "2026-10-13T00:00:00.000Z" };
  const item = itemFromSocialPost("run-1", post);
  assert.deepEqual(item.metrics.views, { value: 1200, state: "OBSERVED" });
  assert.deepEqual(item.metrics.likes, { value: null, state: "UNAVAILABLE" }, "a metric the scraper did not report is not invented");
  const again = itemFromSocialPost("run-2", post);
  assert.equal(again.contentHash, item.contentHash, "the same link found by another run is the same record, so it is seen before");
});

test("the job result counts each state and invents no figure", () => {
  const rows: GatheredSource[] = [
    { source: "crawler", state: "ok", reason: "", items: 3 },
    { source: "tiktok", state: "not_connected", reason: "No key", items: 0 },
    { source: "reddit", state: "failed", reason: "HTTP 503", items: 0 },
    { source: "upload", state: "not_connected", reason: "None saved", items: 0 },
  ];
  assert.equal(gatheredSummary(rows), "gathered:ok=1;not_connected=2;failed=1");
});
