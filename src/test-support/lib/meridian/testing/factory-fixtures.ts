/**
 * Shared fixtures for the Content Factory tests. A test database runs every migration in filename order on PGlite, so the
 * schema under test is the schema that ships. Nothing here calls a live provider: each provider's answer is a fixture shaped
 * after its documented response, and any other request is refused.
 */

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "../../../../lib/meridian/learning/store.ts";
import type { ExecutableJob } from "../../../../lib/meridian/jobs/execute.ts";
import type { GatherDeps } from "../../../../lib/meridian/factory/gather.ts";
import { GATHER_PLATFORM_ADAPTERS } from "../../../../lib/meridian/factory/gather.ts";
import { crawlLadderPage } from "../../../../lib/meridian/discovery/crawler.ts";
import { scrapeSocialUrl } from "../../../../lib/meridian/sources/scraper/social-scraper.ts";
import { SourceRegistry } from "../../../../lib/meridian/sources/registry.ts";
import type { SourceAdapter, SourceHealth, SourceKind, SourceReference } from "../../../../lib/meridian/sources/types.ts";
import type { Transport } from "../../../../lib/meridian/providers/http.ts";
import { notConnectedApifyClient } from "../../../../lib/meridian/sources/apify/client.ts";

export const FACTORY_TEST_ORG = "org-factory";
export const FACTORY_TEST_BRAND = "brand-factory";
export const FACTORY_TEST_RUN = "run-factory";

/** The public website the brand lists. A bare domain, as a person would type it. */
export const FIXTURE_BRAND_WEBSITE = "glowskin.example";

/** A confirmed competitor's TikTok video. The social scraper reads it. */
export const FIXTURE_TIKTOK_LINK = "https://www.tiktok.com/@glowskinco/video/7123456789012345678";

/** Creates a PGlite database with every migration applied, behind the same tag the server code uses. */
export async function makeFactoryTestSql(): Promise<Sql> {
  const db = new PGlite({ extensions: { vector } });
  await db.waitReady;
  const dir = join(process.cwd(), "migrations");
  const names = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  await db.exec("create table if not exists _migrations (name text primary key)");
  for (const name of names) {
    await db.exec(await readFile(join(dir, name), "utf8"));
  }
  const sql = sqlOver(db);
  // A real transaction, as the worker's connection has. The learn stage replaces a brand's patterns inside one transaction.
  sql.begin = <T>(fn: (tx: Sql) => Promise<T>) => db.transaction((tx) => fn(sqlOver(tx)));
  return sql;
}

/** A tagged-template connection over a PGlite database or one of its transactions. */
function sqlOver(db: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): Sql {
  const sql = (async <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? "";
    for (let index = 0; index < values.length; index += 1) text += `$${index + 1}${strings[index + 1] ?? ""}`;
    const result = await db.query(text, values);
    return result.rows as T[];
  }) as Sql;
  sql.query = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await db.query(text, params)).rows as T[];
  return sql;
}

/** A workspace, a brand and one Factory run with the given stored settings. The run starts queued, as startFactoryRun leaves it. */
export async function seedFactoryRun(
  sql: Sql,
  input: { settings: Record<string, unknown>; level: number; niche?: string; website?: string; country?: string },
): Promise<void> {
  await sql`insert into organizations (id, name, slug, created_by) values (${FACTORY_TEST_ORG}, 'Factory test', 'factory-test', 'user-1')`;
  await sql`
    insert into brands (id, organization_id, name, created_by, website, country_market)
    values (${FACTORY_TEST_BRAND}, ${FACTORY_TEST_ORG}, 'Brand', 'user-1', ${input.website ?? ""}, ${input.country ?? ""})
  `;
  await sql`
    insert into factory_runs (id, organization_id, brand_id, niche, level, status, current_stage, created_by, settings)
    values (${FACTORY_TEST_RUN}, ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${input.niche ?? "skincare"}, ${input.level},
      'queued', 'factory.discover', 'user-1', ${JSON.stringify(input.settings)})
  `;
}

/** A confirmed competitor of the test brand, with the website the brand's records hold for it. */
export async function seedConfirmedCompetitor(sql: Sql, input: { id: string; name: string; website: string }): Promise<void> {
  await sql`
    insert into competitors (id, organization_id, brand_id, name, website, status, created_by)
    values (${input.id}, ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${input.name}, ${input.website}, 'confirmed', 'user-1')
  `;
}

/** The durable job row a discover stage runs under. The Ad Library collection it opens is recorded against this row. */
export async function seedJobRow(sql: Sql, jobId: string, jobType: string): Promise<void> {
  await sql`
    insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, payload, max_attempts)
    values (${jobId}, ${FACTORY_TEST_ORG}, ${FACTORY_TEST_BRAND}, ${jobType}, ${`factory:${jobId}`}, 'running', '{}', 5)
  `;
}

/** The job the durable queue would hand the worker for one Factory stage of the test run. */
export function factoryJob(stage: string, id = `job-${stage}`, brandId = FACTORY_TEST_BRAND): ExecutableJob {
  return {
    id,
    organization_id: FACTORY_TEST_ORG,
    brand_id: brandId,
    job_type: stage,
    payload: JSON.stringify({ runId: FACTORY_TEST_RUN }),
    attempts: 0,
    max_attempts: 3,
  };
}

/** The run row's status, stage and reason, as the Factory board reads them. */
export async function factoryRunRow(sql: Sql): Promise<{ status: string; current_stage: string; error: string }> {
  const rows = await sql<{ status: string; current_stage: string; error: string }>`
    select status, current_stage, error from factory_runs where id = ${FACTORY_TEST_RUN}
  `;
  if (!rows[0]) throw new Error("The test run is missing.");
  return rows[0];
}

// ---------------------------------------------------------------------------------------------------------------------------
// Provider fixtures. Each answer has the shape the provider documents. The link is the documentation the shape follows.
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * A public brand page. The Open Graph and title tags follow the Open Graph protocol (https://ogp.me/), and the product card is
 * the kind of repeated block the crawler reads.
 */
export const FIXTURE_PAGE_HTML = `<!doctype html>
<html>
<head>
  <title>Glow Skin Co</title>
  <meta name="description" content="Serums for everyday glow.">
  <link rel="canonical" href="https://glowskin.example/">
  <meta property="og:title" content="Glow Skin Co">
  <meta property="og:description" content="Serums for everyday glow.">
  <meta property="og:image" content="https://glowskin.example/og.jpg">
</head>
<body>
  <article class="product-card">
    <h3>Glow Serum</h3>
    <p>Brightens skin in two weeks.</p>
    <a href="/shop/glow-serum">Shop</a>
  </article>
</body>
</html>`;

/**
 * A Meta Ad Library ads_archive response with the fields the collector requests. Shaped after Meta's documented response
 * (https://developers.facebook.com/docs/graph-api/reference/ads_archive/). The first ad has stopped delivering, so it carries an
 * ad_delivery_stop_time. The second is still delivering, so the field is absent, as Meta omits it.
 */
export const FIXTURE_AD_LIBRARY_RESPONSE = {
  data: [
    {
      id: "1020304050607080",
      page_id: "1122334455",
      page_name: "Glow Skin Co",
      ad_snapshot_url: "https://www.facebook.com/ads/archive/render_ad/?id=1020304050607080",
      ad_delivery_start_time: "2026-09-01T07:00:00+0000",
      ad_delivery_stop_time: "2026-09-20T07:00:00+0000",
      ad_reached_countries: ["US", "CA"],
      ad_creative_bodies: ["Dry hands? Try the gentle serum. Shop now."],
      ad_creative_link_titles: ["Gentle glow serum"],
      ad_creative_link_descriptions: ["Two weeks to brighter skin"],
      publisher_platforms: ["facebook", "instagram"],
    },
    {
      id: "1020304050607081",
      page_id: "1122334455",
      page_name: "Glow Skin Co",
      ad_snapshot_url: "https://www.facebook.com/ads/archive/render_ad/?id=1020304050607081",
      ad_delivery_start_time: "2026-10-02T07:00:00+0000",
      ad_reached_countries: ["US"],
      ad_creative_bodies: ["Morning routine in 30 seconds."],
      ad_creative_link_titles: [],
      ad_creative_link_descriptions: [],
      publisher_platforms: ["facebook"],
    },
  ],
};

/**
 * TikTok's public oEmbed response for a video (https://developers.tiktok.com/doc/embed-videos/). The social scraper reads the
 * title, author fields and thumbnail from it.
 */
export const FIXTURE_TIKTOK_OEMBED = {
  version: "1.0",
  type: "video",
  title: "Glow serum in 30 seconds #skincare",
  author_url: "https://www.tiktok.com/@glowskinco",
  author_name: "Glow Skin Co",
  author_unique_id: "glowskinco",
  width: "100%",
  height: "exact-height",
  html: "<blockquote class=\"tiktok-embed\"></blockquote>",
  thumbnail_width: 480,
  thumbnail_height: 640,
  thumbnail_url: "https://p16-sign.tiktokcdn.com/fixture-thumbnail.jpeg",
  provider_url: "https://www.tiktok.com",
  provider_name: "TikTok",
};

/** The Ad Library transport. It answers only the ads_archive request, with the fixture above. */
export function adLibraryTransport(): Transport {
  return async (request) => {
    if (!request.url.startsWith("https://graph.facebook.com/v21.0/ads_archive?")) {
      throw new Error(`The fixture transport refuses ${request.url}.`);
    }
    return { status: 200, headers: {}, body: JSON.stringify(FIXTURE_AD_LIBRARY_RESPONSE) };
  };
}

/**
 * Runs an action with global fetch limited to the TikTok oEmbed fixture. Any other request throws, so no live request is made
 * while the action runs. The previous fetch is restored afterwards.
 */
export async function withFixtureFetch<T>(action: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://www.tiktok.com/oembed?")) {
      return new Response(JSON.stringify(FIXTURE_TIKTOK_OEMBED), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`The fixture fetch refuses ${url}.`);
  }) as typeof fetch;
  try {
    return await action();
  } finally {
    globalThis.fetch = original;
  }
}

/** How a fixture source answers the health check and the search. A source with no entry has no key. */
export type FixtureSourceBehaviour = {
  health: SourceHealth["status"];
  message?: string;
  discover?: () => Promise<SourceReference[]>;
};

/** The platform sources the gather tests use. Every other platform has no key, so it is reported as not connected. */
export const FIXTURE_PLATFORM_BEHAVIOUR: Record<string, FixtureSourceBehaviour> = {
  website: { health: "HEALTHY" },
  // A saved key is required. None is saved, so the search does not run.
  tiktok: { health: "NOT_CONFIGURED", message: "No TikTok key is saved for this workspace, so TikTok search did not run." },
  // A key is saved and the search returns no posts for this niche: a run that ran and found nothing.
  youtube: { health: "CONFIGURED", discover: async () => [] },
  // A key is saved and the search fails: the source records the error and the run goes on.
  reddit: {
    health: "CONFIGURED",
    discover: async () => {
      throw new Error("Reddit search returned HTTP 503. No posts were read.");
    },
  },
};

const FIXTURE_CHECKED_AT = "2026-10-13T00:00:00.000Z";

function fixtureAdapter(id: string, behaviour: FixtureSourceBehaviour): SourceAdapter {
  return {
    id,
    platform: id as SourceKind,
    capabilities: {
      profileDiscovery: false,
      contentDiscovery: true,
      metadata: false,
      videos: false,
      images: false,
      comments: false,
      performance: false,
      webpages: false,
      search: true,
    },
    async discover() {
      return behaviour.discover ? behaviour.discover() : [];
    },
    async fetch() {
      throw new Error("The fixture source does not fetch.");
    },
    async health() {
      return {
        adapterId: id,
        status: behaviour.health,
        latencyMs: 0,
        message: behaviour.message,
        lastCheckedAt: FIXTURE_CHECKED_AT,
      };
    },
  };
}

/**
 * A registry in which every source the gather can reach is a fixture. The real adapters are replaced by id, so none of them can
 * reach the network or read a saved key.
 */
export function fixtureSourceRegistry(behaviour: Record<string, FixtureSourceBehaviour> = FIXTURE_PLATFORM_BEHAVIOUR): SourceRegistry {
  const registry = new SourceRegistry();
  for (const id of ["website", "meta_ad_library", ...GATHER_PLATFORM_ADAPTERS]) {
    registry.register(fixtureAdapter(id, behaviour[id] ?? { health: "NOT_CONFIGURED", message: `No ${id} key is saved for this workspace.` }));
  }
  return registry;
}

/** The gather's seams, all fixtures. The crawler reads FIXTURE_PAGE_HTML for every page; the social scraper runs for real over the stub fetch. */
export function fixtureGatherDeps(options: { metaToken: string | null; scrapeSocial?: GatherDeps["scrapeSocial"] }): GatherDeps {
  return {
    registry: fixtureSourceRegistry(),
    crawlPage: (url, runId, allowedHosts) =>
      crawlLadderPage(url, runId, allowedHosts, { fetchHtml: async (target) => ({ url: target, html: FIXTURE_PAGE_HTML }) }),
    scrapeSocial: options.scrapeSocial ?? scrapeSocialUrl,
    metaToken: async () => options.metaToken,
    metaTransport: adLibraryTransport(),
    // No Apify key in the fixtures: the Instagram volume source reports not connected, and no request is sent.
    apify: notConnectedApifyClient("Apify has no key for this workspace in the test, so no Instagram candidates were gathered."),
  };
}
