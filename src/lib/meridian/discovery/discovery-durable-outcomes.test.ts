import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { DiscoveryFrontierService } from "./frontier.ts";
import { DiscoveryService, type PageCrawler } from "./service.ts";

type CrawlResult = Awaited<ReturnType<PageCrawler>>;

function page(url: string): CrawlResult {
  return {
    url,
    finalUrl: url,
    title: `Page ${url}`,
    description: `Description for ${url}`,
    canonicalUrl: url,
    openGraph: {},
    jsonLd: [],
    cards: [],
    outboundLinks: [],
  } as unknown as CrawlResult;
}

/** Scripted page fetch. URLs in `failing` reject; every other URL returns a fixed page. */
function crawler(failing: string[] = []): PageCrawler {
  return (async (url: string) => {
    if (failing.includes(url)) throw new Error(`fixture: fetch failed for ${url}`);
    return page(url);
  }) as PageCrawler;
}

/** Fails the first statement whose text contains `marker`, then passes everything through. */
function failFirstStatement(sql: Sql, marker: string): Sql {
  let failed = false;
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!failed && strings.join("?").includes(marker)) {
      failed = true;
      throw new Error("fixture: injected persistence failure");
    }
    return (sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>)(strings, ...values);
  }) as unknown as Sql;
}

async function tenant(sql: Sql, label: string) {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const organizationId = `org-disc-${suffix}`;
  const brandId = `brand-disc-${suffix}`;
  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, 'test-user')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${organizationId}, ${brandId}, 'test-user')`;
  return { organizationId, brandId };
}

async function storedStatus(sql: Sql, runId: string) {
  const rows = await sql<{ status: string }>`select status from discovery_runs where id = ${runId}`;
  return rows[0]?.status;
}

async function storedItemCount(sql: Sql, runId: string) {
  const rows = await sql<{ count: number }>`select count(*)::int as count from discovered_items where run_id = ${runId}`;
  return Number(rows[0]?.count ?? 0);
}

async function frontierStatus(sql: Sql, runId: string, url: string) {
  const rows = await sql<{ status: string }>`select status from discovery_frontier where run_id = ${runId} and url = ${url}`;
  return rows[0]?.status;
}

test("scrape_page: a clean run with one page reports completed and stores its item", async () => {
  const sql = await getSql();
  const { organizationId, brandId } = await tenant(sql, "scrape-clean");
  const service = new DiscoveryService(undefined, crawler());
  const { run } = await service.startDiscoveryRun({
    organizationId, brandId, scope: "scrape_page", seeds: ["https://fixture.example/clean"], sql,
  });
  assert.equal(run.status, "completed");
  assert.equal(await storedStatus(sql, run.id), "completed");
  assert.equal(await storedItemCount(sql, run.id), 1);
});

test("scrape_page: a failed item insert reports partial, not completed, and stores nothing for that item", async () => {
  const sql = await getSql();
  const { organizationId, brandId } = await tenant(sql, "scrape-persist");
  const service = new DiscoveryService(undefined, crawler());
  const { run } = await service.startDiscoveryRun({
    organizationId,
    brandId,
    scope: "scrape_page",
    seeds: ["https://fixture.example/persist"],
    sql: failFirstStatement(sql, "insert into discovered_items"),
  });
  assert.equal(run.status, "partial");
  assert.ok(
    Object.keys(run.perSourceErrors).some((key) => key.startsWith("persist_")),
    "the failed insert must be recorded against its item",
  );
  assert.equal(await storedStatus(sql, run.id), "partial", "the durable run must not claim completion");
  assert.equal(await storedItemCount(sql, run.id), 0);
});

test("scrape_page: a seed that fails to crawl makes the run partial even when another page succeeded", async () => {
  const sql = await getSql();
  const { organizationId, brandId } = await tenant(sql, "scrape-partial");
  const ok = "https://fixture.example/ok";
  const down = "https://fixture.example/down";
  const service = new DiscoveryService(undefined, crawler([down]));
  const { run } = await service.startDiscoveryRun({
    organizationId, brandId, scope: "scrape_page", seeds: [ok, down], sql,
  });
  assert.equal(run.progress.pagesCrawled, 1);
  assert.equal(run.status, "partial");
  assert.equal(await storedStatus(sql, run.id), "partial");
});

test("page_plus_links: a page that fails terminally in the durable frontier leaves the run partial", async () => {
  const sql = await getSql();
  const { organizationId, brandId } = await tenant(sql, "frontier-terminal");
  const good = "https://fixture.example/good";
  const bad = "https://fixture.example/bad";
  const service = new DiscoveryService(undefined, crawler([bad]));
  const { run } = await service.startDiscoveryRun({
    organizationId, brandId, scope: "page_plus_links", seeds: [good, bad], sql,
  });

  // The first failure is retried with backoff. Clear the backoff and resume until the retry budget is spent.
  let latest = run;
  for (let attempt = 0; attempt < 8 && (await frontierStatus(sql, run.id, bad)) !== "FAILED"; attempt++) {
    await sql`update discovery_frontier set next_attempt_at = now() - interval '1 second' where run_id = ${run.id} and url = ${bad}`;
    latest = await service.resumeDiscoveryRun({ organizationId, brandId, runId: run.id, sql });
  }
  assert.equal(await frontierStatus(sql, run.id, bad), "FAILED", "the bad page must reach its terminal failure");
  assert.equal(latest.status, "partial");
  assert.equal(await storedStatus(sql, run.id), "partial");
});

test("page_plus_links: resuming a run re-enqueues seeds lost to a crash during the original enqueue", async () => {
  const sql = await getSql();
  const { organizationId, brandId } = await tenant(sql, "resume-seeds");
  const runId = `crawll_resume_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const first = "https://fixture.example/first";
  const second = "https://fixture.example/second";
  await sql`
    insert into discovery_runs (
      id, organization_id, brand_id, scope, status, seeds, budget, progress, per_source_errors, started_at
    ) values (
      ${runId}, ${organizationId}, ${brandId}, 'page_plus_links', 'running',
      ${JSON.stringify([first, second])}::jsonb,
      ${JSON.stringify({ maxPages: 10, maxDepth: 2, concurrency: 2, delayMs: 100 })}::jsonb,
      ${JSON.stringify({ pagesCrawled: 0, discoveredCards: 0, discoveredUrls: 0 })}::jsonb,
      '{}'::jsonb, now()
    )
  `;
  // The process died after enqueueing the first seed and before the second.
  await DiscoveryFrontierService.enqueueLinks(sql, {
    organizationId, brandId, runId, links: [{ url: first, canonicalUrl: first, depth: 1, priority: 10 }],
  });

  const service = new DiscoveryService(undefined, crawler());
  const run = await service.resumeDiscoveryRun({ organizationId, brandId, runId, sql });
  assert.equal(run.progress.pagesCrawled, 2, "the seed missing from the crashed enqueue must be crawled");
  assert.equal(run.status, "completed");
  assert.equal(await storedStatus(sql, runId), "completed");
});
