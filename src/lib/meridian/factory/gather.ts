/**
 * Factory Gather (NORTH_STAR section 5, step 1; section 8, item 3).
 *
 * The discover stage runs the existing sourcing stack for one run:
 *  - the crawler reads the public websites of the brand and its confirmed competitors (discovery service, website adapter);
 *  - the social scraper reads the social post and profile links among those websites;
 *  - the source adapters in the registry search the run's niche on the run's platforms (one discovery run for both the crawl
 *    and the search);
 *  - the Meta Ad Library collector stores the ads that grading reads;
 *  - uploads, which no intake stores yet.
 *
 * Each source records one state on the run: ok, not_connected, or failed with its error. A source that is not connected or
 * fails does not stop the run, which continues with what it has. Gathered items go to the evidence tables that already exist:
 * research_ads, discovered_items, discovered_page_evidence and sources. No second evidence store is written.
 */

import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { DiscoveryService, type PageCrawler } from "../discovery/service.ts";
import { crawlLadderPage } from "../discovery/crawler.ts";
import { canonicalPageKey, contentHashOf, type RecordProvenance } from "../discovery/content-identity.ts";
import { storeDiscoveredItem, upsertItemSource } from "../discovery/item-store.ts";
import type { DiscoveredItem, DiscoveryRun, SourceRunState } from "../discovery/types.ts";
import { sourceRegistry, type SourceRegistry } from "../sources/registry.ts";
import { pageUrlForSeed } from "../sources/public-url.ts";
import { sourceKeyFor } from "../sources/credentials.ts";
import { scrapeSocialUrl, type ScrapedSocialPost } from "../sources/scraper/social-scraper.ts";
import { collectMetaAdLibrary } from "../providers/meta-research.ts";
import { liveTransport, type Transport } from "../providers/http.ts";
import { persistMetaAd } from "../research/store.ts";

/** The most ads one run asks the Ad Library for. */
export const AD_LIBRARY_LIMIT = 25;

/** The runs the Factory board lists. The source states are read for the same runs. */
export const RECENT_RUNS_LIMIT = 8;

/** The registry adapters a niche search covers when a run names no platform. Meta Ad Library has its own collector. */
export const GATHER_PLATFORM_ADAPTERS = [
  "instagram",
  "tiktok",
  "youtube",
  "twitter",
  "facebook",
  "pinterest",
  "linkedin",
  "reddit",
  "search",
  "licensed",
  "cyclone_scout",
] as const;

/** Hosts the social scraper reads a post or profile from. A saved link on one of these hosts is read by the scraper. */
const SOCIAL_HOSTS = [
  "instagram.com",
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "x.com",
  "twitter.com",
  "threads.net",
  "facebook.com",
  "fb.watch",
  "pinterest.com",
  "pin.it",
  "reddit.com",
  "redd.it",
  "linkedin.com",
];

const UPLOAD_REASON = "No uploaded swipe file reaches this run. The upload parser is not connected to a saved upload yet.";

export type GatherState = "ok" | "not_connected" | "failed";

export type GatheredSource = { source: string; state: GatherState; reason: string; items: number };

/** The state of one call a source made, before the calls are combined into the source's state. */
type Call = { state: GatherState; reason: string; items: number };

/**
 * The network seams the gather uses. Production uses the live sources. A test passes fixtures, so no request leaves the test
 * and no key is read from a workspace.
 */
export type GatherDeps = {
  registry: SourceRegistry;
  crawlPage: PageCrawler;
  scrapeSocial: (url: string) => Promise<ScrapedSocialPost>;
  /** The saved Ad Library token for the workspace, or null when none is saved. */
  metaToken: (organizationId: string) => Promise<string | null>;
  metaTransport: Transport;
};

export function defaultGatherDeps(): GatherDeps {
  return {
    registry: sourceRegistry,
    crawlPage: crawlLadderPage,
    scrapeSocial: scrapeSocialUrl,
    metaToken: async (organizationId) => (await sourceKeyFor("meta_ad_library", organizationId)).secret,
    metaTransport: liveTransport(),
  };
}

export type GatherInput = {
  organizationId: string;
  brandId: string;
  /** The Factory run the states are recorded on. */
  runId: string;
  /** The discover job. The Ad Library collection it opens is recorded against this job. */
  jobId: string;
  createdBy: string;
  niche: string;
  /** The run's platforms. Empty means every platform the niche search covers. */
  platforms: readonly string[];
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Lower-case host check, so a link on a social network is read by the scraper and not by the crawler. */
export function isSocialUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return SOCIAL_HOSTS.some((social) => host === social || host.endsWith(`.${social}`));
}

/** The saved website values, split into the public pages the crawler reads and the social links the scraper reads. */
export function seedsFrom(values: readonly string[]): { pages: string[]; socialLinks: string[]; unreadable: number } {
  const pages = new Map<string, string>();
  const social = new Map<string, string>();
  let unreadable = 0;
  for (const value of values) {
    const url = pageUrlForSeed(value);
    if (!url) {
      // A saved value that is not an address (for example a shop name) is counted, so the source says it was not read.
      if (value.trim()) unreadable += 1;
      continue;
    }
    const key = canonicalPageKey(url);
    if (isSocialUrl(url)) {
      if (!social.has(key)) social.set(key, url);
    } else if (!pages.has(key)) {
      pages.set(key, url);
    }
  }
  return { pages: [...pages.values()], socialLinks: [...social.values()], unreadable };
}

/** The platform adapters a run searches. A run that names platforms gets exactly those, each reported even when not connected. */
export function platformAdaptersFor(platforms: readonly string[]): string[] {
  if (platforms.length === 0) return [...GATHER_PLATFORM_ADAPTERS];
  return [...new Set(platforms.filter((id) => id !== "meta_ad_library"))];
}

function callOf(state: SourceRunState): Call {
  if (state.status === "ran") return { state: "ok", reason: "", items: state.itemsFound };
  if (state.status === "failed") return { state: "failed", reason: state.reason, items: 0 };
  return { state: "not_connected", reason: state.reason, items: 0 };
}

/**
 * One source's state from the calls it made. A failed call is shown even when other calls worked, with the items the working
 * calls stored. With no call at all, the fallback says why nothing was read.
 */
function combine(calls: readonly Call[], fallback: Call): Call {
  if (calls.length === 0) return fallback;
  const items = calls.reduce((sum, call) => sum + call.items, 0);
  const failed = calls.filter((call) => call.state === "failed");
  if (failed.length > 0) {
    return { state: "failed", reason: [...new Set(failed.map((call) => call.reason))].join(" "), items };
  }
  if (calls.some((call) => call.state === "ok")) return { state: "ok", reason: "", items };
  const reasons = [...new Set(calls.map((call) => call.reason).filter(Boolean))];
  return { state: "not_connected", reason: reasons.join(" ") || fallback.reason, items: 0 };
}

function countryOf(value: string): string {
  const country = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : "US";
}

/** Observed when the source reported the number, and unavailable when it did not. A number is never invented. */
function observed(value: number | undefined): DiscoveredItem["metrics"][string] {
  return value === undefined ? { value: null, state: "UNAVAILABLE" } : { value, state: "OBSERVED" };
}

/** The item a scraped post becomes. Its hash is stable per platform and link, so a repeat is recognised as seen before. */
export function itemFromSocialPost(runId: string, post: ScrapedSocialPost): DiscoveredItem {
  const canonicalUrl = canonicalPageKey(post.url);
  const contentHash = contentHashOf([post.platform, canonicalUrl]);
  return {
    id: `item_${runId}_social_${contentHash.slice(0, 16)}`,
    runId,
    url: post.url,
    canonicalUrl,
    source: post.platform,
    cardType: post.videoUrl ? "video" : "post",
    title: post.title || undefined,
    text: post.caption || undefined,
    creator: post.authorHandle || post.authorName || undefined,
    mediaUrl: post.thumbnailUrl || undefined,
    metrics: { views: observed(post.views), likes: observed(post.likes), comments: observed(post.comments) },
    contentHash,
    sourceLocation: post.url,
    discoveredAt: post.extractedAt,
  };
}

/** The scraper reports a failed read as an error in rawPayload, not as a throw. A read with no content is a failure. */
function scrapeErrorOf(post: ScrapedSocialPost): string {
  const error = post.rawPayload?.error;
  if (typeof error !== "string" || !error) return "";
  if (post.title || post.caption || post.thumbnailUrl || post.videoUrl) return "";
  return error;
}

async function scrapeSocialLink(
  sql: Sql,
  input: { organizationId: string; brandId: string; runId: string },
  url: string,
  deps: GatherDeps,
): Promise<Call> {
  try {
    const post = await deps.scrapeSocial(url);
    const scrapeError = scrapeErrorOf(post);
    if (scrapeError) return { state: "failed", reason: scrapeError, items: 0 };
    const item = itemFromSocialPost(input.runId, post);
    const provenance: RecordProvenance = {
      organizationId: input.organizationId,
      brandId: input.brandId,
      runId: input.runId,
      adapterId: post.platform,
      sourceStatus: "UNKNOWN",
    };
    const outcome = await storeDiscoveredItem(sql, provenance, item);
    if (outcome === "stored") await upsertItemSource(sql, provenance, item);
    return { state: "ok", reason: "", items: outcome === "stored" ? 1 : 0 };
  } catch (error) {
    return { state: "failed", reason: messageOf(error), items: 0 };
  }
}

/**
 * Opens the Ad Library collection for this job. The ads it stores need a collection row, which research_ads references. One
 * job has one row, so a retried discover reuses it.
 */
async function openCollectionRun(sql: Sql, input: GatherInput, country: string): Promise<string> {
  const rows = await sql<{ id: string }>`
    insert into research_collection_runs (id, organization_id, brand_id, job_id, search_terms, country, status, created_by)
    values (${randomUUID()}, ${input.organizationId}, ${input.brandId}, ${input.jobId}, ${input.niche}, ${country}, 'collecting', ${input.createdBy})
    on conflict (organization_id, job_id) do update set
      search_terms = excluded.search_terms, country = excluded.country, status = 'collecting', error = '', updated_at = now()
    returning id
  `;
  if (!rows[0]) throw new Error("The Ad Library collection could not be opened.");
  return rows[0].id;
}

async function closeCollectionRun(
  sql: Sql,
  input: { organizationId: string; brandId: string },
  collectionRunId: string,
  status: "succeeded" | "NOT_CONNECTED" | "failed",
  error: string,
  collected: number,
): Promise<void> {
  await sql`
    update research_collection_runs
    set status = ${status}, error = ${error.slice(0, 500)}, collected_count = ${collected}, updated_at = now()
    where id = ${collectionRunId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
  `;
}

/** Collects the brand's niche from the Meta Ad Library and stores each ad, with its stop time and countries, for grading. */
async function gatherAdLibrary(sql: Sql, input: GatherInput, country: string, deps: GatherDeps): Promise<Call> {
  let collectionRunId = "";
  try {
    const token = await deps.metaToken(input.organizationId);
    collectionRunId = await openCollectionRun(sql, input, country);
    const collected = await collectMetaAdLibrary({
      token: token ?? undefined,
      searchTerms: input.niche,
      country,
      limit: AD_LIBRARY_LIMIT,
      transport: deps.metaTransport,
    });
    if (collected.status !== "CONNECTED") {
      const notConnected = collected.status === "NOT_CONNECTED";
      await closeCollectionRun(sql, input, collectionRunId, notConnected ? "NOT_CONNECTED" : "failed", collected.error, 0);
      return { state: notConnected ? "not_connected" : "failed", reason: collected.error, items: 0 };
    }
    for (const ad of collected.ads) {
      await persistMetaAd(sql, { organizationId: input.organizationId, brandId: input.brandId, runId: collectionRunId, ad });
    }
    await closeCollectionRun(sql, input, collectionRunId, "succeeded", "", collected.ads.length);
    return { state: "ok", reason: "", items: collected.ads.length };
  } catch (error) {
    const message = messageOf(error);
    if (collectionRunId) await closeCollectionRun(sql, input, collectionRunId, "failed", message, 0).catch(() => undefined);
    return { state: "failed", reason: message, items: 0 };
  }
}

async function writeRunSources(sql: Sql, input: GatherInput, rows: readonly GatheredSource[]): Promise<void> {
  for (const row of rows) {
    await sql`
      insert into factory_run_sources (run_id, organization_id, brand_id, source, state, reason, items)
      values (${input.runId}, ${input.organizationId}, ${input.brandId}, ${row.source}, ${row.state}, ${row.reason.slice(0, 500)}, ${row.items})
      on conflict (run_id, source) do update set
        state = excluded.state, reason = excluded.reason, items = excluded.items, created_at = now()
    `;
  }
}

/**
 * Gathers one Factory run's sources and records each source's state on the run. Returns the states in the order the board
 * shows them. A source that is not connected or fails is recorded and the run goes on, so this only throws when the run itself
 * cannot be read or its states cannot be written.
 */
export async function gatherForRun(sql: Sql, input: GatherInput, deps: GatherDeps = defaultGatherDeps()): Promise<GatheredSource[]> {
  const brands = await sql<{ website: string; country_market: string }>`
    select website, country_market from brands
    where id = ${input.brandId} and organization_id = ${input.organizationId} and deleted_at is null
    limit 1
  `;
  if (!brands[0]) throw new Error("Brand not found for this Factory run.");
  const competitors = await sql<{ website: string }>`
    select website from competitors
    where brand_id = ${input.brandId} and organization_id = ${input.organizationId} and status = 'confirmed' and website <> ''
    order by created_at asc
  `;
  const country = countryOf(brands[0].country_market);
  const { pages, socialLinks, unreadable } = seedsFrom([brands[0].website, ...competitors.map((row) => row.website)]);
  const platformAdapters = platformAdaptersFor(input.platforms);

  // One discovery run covers the crawl of the pages and the niche search. The planner reports each source's state for each seed.
  let run: DiscoveryRun | null = null;
  let discoveryError = "";
  try {
    const started = await new DiscoveryService(deps.registry, deps.crawlPage).startDiscoveryRun({
      organizationId: input.organizationId,
      brandId: input.brandId,
      scope: "niche",
      seeds: [input.niche, ...pages],
      adapterIds: ["website", ...platformAdapters],
      sql,
    });
    run = started.run;
  } catch (error) {
    discoveryError = messageOf(error);
  }
  const calls = (pick: (state: SourceRunState) => boolean): Call[] =>
    (run?.progress.sources ?? []).filter(pick).map(callOf);

  const crawler = combine(
    calls((state) => state.adapterId === "website" && state.seed !== input.niche),
    pages.length === 0
      ? {
          state: "not_connected",
          reason: unreadable > 0
            ? `No public website is saved for this brand or its confirmed competitors. ${unreadable} saved website value(s) are not page addresses, so none was read.`
            : "No public website is saved for this brand or its confirmed competitors.",
          items: 0,
        }
      : discoveryError
        ? { state: "failed", reason: discoveryError, items: 0 }
        : { state: "not_connected", reason: "The crawler did not read the saved websites.", items: 0 },
  );

  let social: Call;
  if (socialLinks.length === 0) {
    social = { state: "not_connected", reason: "No social post or profile link is saved for this brand or its confirmed competitors.", items: 0 };
  } else if (!run) {
    social = { state: "failed", reason: `The discovery run did not start: ${discoveryError}`, items: 0 };
  } else {
    const scraped: Call[] = [];
    for (const url of socialLinks) {
      scraped.push(await scrapeSocialLink(sql, { organizationId: input.organizationId, brandId: input.brandId, runId: run.id }, url, deps));
    }
    social = combine(scraped, { state: "failed", reason: "The social scraper did not run.", items: 0 });
  }

  const meta = await gatherAdLibrary(sql, input, country, deps);

  const platformRows: GatheredSource[] = platformAdapters.map((adapterId) => {
    const call = combine(
      calls((state) => state.adapterId === adapterId && state.seed === input.niche),
      discoveryError
        ? { state: "failed", reason: discoveryError, items: 0 }
        : { state: "not_connected", reason: `No ${adapterId} source is available for a niche search in this release.`, items: 0 },
    );
    return { source: adapterId, ...call };
  });

  const rows: GatheredSource[] = [
    { source: "crawler", ...crawler },
    { source: "social_scraper", ...social },
    { source: "meta_ad_library", ...meta },
    ...platformRows,
    { source: "upload", state: "not_connected", reason: UPLOAD_REASON, items: 0 },
  ];
  await writeRunSources(sql, input, rows);
  return rows;
}

/** The job result the worker records for the discover stage. Counts only, so no figure is invented. */
export function gatheredSummary(rows: readonly GatheredSource[]): string {
  const count = (state: GatherState) => rows.filter((row) => row.state === state).length;
  return `gathered:ok=${count("ok")};not_connected=${count("not_connected")};failed=${count("failed")}`;
}

export type FactoryRunSourceRow = { source: string; state: GatherState; reason: string; items: number };

/** Each recent run's source states, keyed by run id, for the Factory board. A run that has not gathered has no entry. */
export async function factoryRunSourcesFor(
  sql: Sql,
  organizationId: string,
  brandId: string,
): Promise<Map<string, FactoryRunSourceRow[]>> {
  const rows = await sql<{ run_id: string; source: string; state: GatherState; reason: string; items: number }>`
    select run_id, source, state, reason, items from factory_run_sources
    where organization_id = ${organizationId} and brand_id = ${brandId}
      and run_id in (
        select id from factory_runs
        where organization_id = ${organizationId} and brand_id = ${brandId}
        order by created_at desc
        limit ${RECENT_RUNS_LIMIT}
      )
    order by created_at asc, source asc
  `;
  const byRun = new Map<string, FactoryRunSourceRow[]>();
  for (const row of rows) {
    const list = byRun.get(row.run_id) ?? [];
    list.push({ source: row.source, state: row.state, reason: row.reason, items: Number(row.items) });
    byRun.set(row.run_id, list);
  }
  return byRun;
}
