/**
 * Discovery Service & Research Frontier
 *
 * Coordinates multi-page and whole-niche crawling, repeated card extraction, deduplication, and integration with the
 * universal SourceRegistry.
 *
 * Every run records one state per source and seed: ran, not configured (with the resolver's reason), not supported, or
 * failed (with the error). A source that did not run is never counted as connected. A public page is read through one
 * pipeline whether it is a scrape seed, a niche URL, or a frontier page, so its evidence and provenance are the same.
 */

import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { sourceRegistry, SourceRegistry } from "../sources/registry.ts";
import { pageUrlForSeed } from "../sources/public-url.ts";
import type { SourceReference } from "../sources/types.ts";
import { crawlLadderPage, type PageCrawlResult } from "./crawler.ts";
import { ResearchPlanner, type PlannedSourceExecution } from "./planner.ts";
import { DiscoveryFrontierService } from "./frontier.ts";
import { persistPageEvidence } from "./page-evidence.ts";
import { canonicalPageKey, contentHashOf, type RecordProvenance } from "./content-identity.ts";
import { storeDiscoveredItem, upsertItemSource, type ItemOutcome } from "./item-store.ts";
import type {
  DiscoveryScope,
  DiscoveryRun,
  DiscoveredItem,
  CrawlBudget,
  SourceRunState,
} from "./types.ts";

export type PageCrawler = typeof crawlLadderPage;

/** The progress column also carries the caveat, because the run row has no caveat column. */
type StoredProgress = DiscoveryRun["progress"] & { caveat?: string | null };

/** The working state of one run. `items` holds only what this run stored, never what it matched as seen before. */
interface RunContext {
  sql: Sql;
  run: DiscoveryRun;
  /** Content hashes already handled in this run, so one run never stores an item twice. */
  seenHashes: Set<string>;
  items: DiscoveredItem[];
}

interface FrontierOutcome {
  remaining: number;
  terminalFailures: number;
}

/**
 * True when any discovered item was not fully stored. Such a run cannot report `completed`, because
 * the caller would otherwise believe every discovered item is durable.
 */
function hasPersistenceFailure(errors: Record<string, string>): boolean {
  return Object.keys(errors).some((key) => key.startsWith("persist_") || key.startsWith("source_"));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unavailableMetrics(): DiscoveredItem["metrics"] {
  return {
    views: { value: null, state: "UNAVAILABLE" },
    likes: { value: null, state: "UNAVAILABLE" },
    comments: { value: null, state: "UNAVAILABLE" },
  };
}

/** Sets the state for one source and seed. A later state for the same pair replaces the earlier one, as on a retry. */
function recordSourceState(run: DiscoveryRun, state: SourceRunState): void {
  const sources = run.progress.sources ?? [];
  run.progress.sources = sources;
  const index = sources.findIndex((entry) => entry.adapterId === state.adapterId && entry.seed === state.seed);
  if (index >= 0) sources[index] = state;
  else sources.push(state);
}

function summarize(sources: SourceRunState[]): { ran: number; failed: number; gated: number } {
  return {
    ran: sources.filter((source) => source.status === "ran").length,
    failed: sources.filter((source) => source.status === "failed").length,
    gated: sources.filter((source) => source.status === "not_configured" || source.status === "not_supported").length,
  };
}

/** The gate state for a planned source that did not run. */
function gateState(exec: PlannedSourceExecution, reason: string): SourceRunState {
  if (exec.status === "failed") {
    return { adapterId: exec.adapterId, seed: exec.seed, status: "failed", reason };
  }
  return {
    adapterId: exec.adapterId,
    seed: exec.seed,
    status: exec.status === "not_supported" ? "not_supported" : "not_configured",
    reason,
  };
}

/**
 * The caveat a person reads with the run. It counts the sources that did not run, so a gated source is never hidden behind
 * the number of items. It also says how many records were matched as seen before.
 */
function caveatFor(sources: SourceRunState[], seenBefore: number, frontierRemaining?: number): string | undefined {
  const parts: string[] = [];
  if (frontierRemaining && frontierRemaining > 0) {
    parts.push(`Crawl paused with ${frontierRemaining} durable frontier item(s) remaining.`);
  }
  const { ran, failed, gated } = summarize(sources);
  if (gated > 0) {
    parts.push(
      ran === 0 && failed === 0
        ? `No source ran. ${gated} planned source check(s) are not configured or not supported; each reason is listed.`
        : `${gated} planned source check(s) did not run because they are not configured or not supported; each reason is listed.`,
    );
  }
  if (seenBefore > 0) {
    parts.push(`${seenBefore} record(s) matched what this brand already stores and were not stored again.`);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** The progress JSON stored with the run. */
function progressJson(run: DiscoveryRun): string {
  const stored: StoredProgress = { ...run.progress, caveat: run.caveat ?? null };
  return JSON.stringify(stored);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

/** Reads the progress column and splits the caveat out of it. */
function progressFromRow(value: unknown): { progress: DiscoveryRun["progress"]; caveat?: string } {
  const { caveat, ...stored } = parseJson<StoredProgress>(value, { pagesCrawled: 0, discoveredCards: 0, discoveredUrls: 0 });
  return {
    progress: {
      ...stored,
      pagesCrawled: Number(stored.pagesCrawled ?? 0),
      discoveredCards: Number(stored.discoveredCards ?? 0),
      discoveredUrls: Number(stored.discoveredUrls ?? 0),
    },
    caveat: typeof caveat === "string" ? caveat : undefined,
  };
}

/** A reference a multi-source adapter returned, as a discovered item. Its hash is stable, so a repeat is recognised. */
function itemFromReference(runId: string, ref: SourceReference, seed: string): DiscoveredItem {
  const url = ref.canonicalUrl || seed;
  const contentHash = contentHashOf([ref.sourceId, ref.canonicalUrl || ""]);
  return {
    id: `item_${runId}_${contentHash.slice(0, 16)}`,
    runId,
    url,
    canonicalUrl: url,
    source: ref.platform,
    cardType: "post",
    title: (ref.metadata?.handle as string) || (ref.metadata?.caption as string) || url,
    text: (ref.metadata?.caption as string) || undefined,
    metrics: unavailableMetrics(),
    contentHash,
    sourceLocation: seed,
    discoveredAt: ref.discoveredAt || new Date().toISOString(),
  };
}

export class DiscoveryService {
  private registry: SourceRegistry;
  private crawlPage: PageCrawler;

  constructor(registry: SourceRegistry = sourceRegistry, crawlPage: PageCrawler = crawlLadderPage) {
    this.registry = registry;
    this.crawlPage = crawlPage;
  }

  /**
   * Executes a budgeted discovery run across the specified scope and seed URLs/handles.
   */
  async startDiscoveryRun(input: {
    organizationId: string;
    brandId: string;
    scope: DiscoveryScope;
    seeds: string[];
    budget?: Partial<CrawlBudget>;
    sql: Sql;
  }): Promise<{
    run: DiscoveryRun;
    items: DiscoveredItem[];
  }> {
    if (!input.sql) throw new Error("Durable SQL is required for discovery; in-memory discovery is disabled.");
    const runId = `crawll_${randomUUID()}`;
    const budget: CrawlBudget = {
      maxPages: Math.min(Math.max(1, input.budget?.maxPages || 10), 100),
      maxDepth: Math.min(Math.max(1, input.budget?.maxDepth || 2), 5),
      concurrency: Math.min(Math.max(1, input.budget?.concurrency || 2), 5),
      allowedHosts: input.budget?.allowedHosts,
      delayMs: input.budget?.delayMs || 100,
    };

    const run: DiscoveryRun = {
      id: runId,
      organizationId: input.organizationId,
      brandId: input.brandId,
      scope: input.scope,
      seeds: input.seeds,
      budget,
      status: "running",
      progress: {
        pagesCrawled: 0,
        discoveredCards: 0,
        discoveredUrls: 0,
        seenBefore: 0,
        sources: [],
      },
      perSourceErrors: {},
      startedAt: new Date().toISOString(),
    };

    const sql = input.sql;
    await sql`
      insert into discovery_runs (
        id, organization_id, brand_id, scope, status, seeds, budget, progress, per_source_errors, started_at
      ) values (
        ${runId}, ${input.organizationId}, ${input.brandId}, ${input.scope}, 'running',
        ${JSON.stringify(input.seeds)}, ${JSON.stringify(budget)}, ${progressJson(run)},
        ${JSON.stringify(run.perSourceErrors)}, now()
      )
    `;

    const ctx: RunContext = { sql, run, seenHashes: new Set(), items: [] };
    let frontier: FrontierOutcome | undefined;
    let fatal = false;
    try {
      if (input.scope === "scrape_page") {
        const websiteStatus = await this.healthStatusOf("website");
        for (const seed of input.seeds) {
          await this.scrapeSeed(ctx, seed, seed, websiteStatus, budget.allowedHosts);
        }
      } else if (input.scope === "page_plus_links" || input.scope === "domain") {
        await DiscoveryFrontierService.enqueueLinks(sql, {
          organizationId: input.organizationId,
          brandId: input.brandId,
          runId,
          links: input.seeds.map((url) => ({ url, canonicalUrl: url, depth: 1, priority: 10 })),
        });
        const storedHashes = await sql<{ content_hash: string }>`
          select content_hash from discovered_items
          where run_id = ${runId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
        `;
        for (const row of storedHashes) ctx.seenHashes.add(row.content_hash);
        frontier = await this.processDurableFrontier(ctx, {
          maxPages: input.scope === "page_plus_links" ? Math.min(budget.maxPages, 5) : budget.maxPages,
          websiteStatus: await this.healthStatusOf("website"),
        });
      } else {
        // Niche, profile, or URL list: every registered adapter the planner lists for each seed.
        await this.discoverAcrossSources(ctx);
      }
    } catch (fatalErr) {
      fatal = true;
      run.perSourceErrors["global"] = errorMessage(fatalErr);
    }

    this.settle(ctx, frontier, fatal);
    run.completedAt = new Date().toISOString();
    run.progress.discoveredCards = ctx.items.filter((item) => item.source === "repeated_card_discovery").length;
    run.progress.discoveredUrls = ctx.items.length;

    // Durable DB run status persistence
    try {
      await sql`
        update discovery_runs
        set status = ${run.status}, progress = ${progressJson(run)},
            per_source_errors = ${JSON.stringify(run.perSourceErrors)},
            completed_at = now(), updated_at = now()
        where id = ${runId}
      `;
    } catch (dbErr) {
      run.status = "failed";
      run.perSourceErrors["database_persistence"] = errorMessage(dbErr);
    }

    return {
      run,
      items: ctx.items,
    };
  }

  /** One scrape seed: the page is read through the shared pipeline, and its state is recorded. */
  private async scrapeSeed(
    ctx: RunContext,
    seed: string,
    pageUrl: string,
    websiteStatus: string,
    allowedHosts?: string[],
  ): Promise<void> {
    try {
      const { stored, seenBefore } = await this.fetchAndStore(ctx, pageUrl, websiteStatus, allowedHosts);
      recordSourceState(ctx.run, { adapterId: "website", seed, status: "ran", itemsFound: stored, seenBefore, sourceStatus: websiteStatus });
    } catch (error) {
      const reason = errorMessage(error);
      ctx.run.perSourceErrors[seed] = reason;
      recordSourceState(ctx.run, { adapterId: "website", seed, status: "failed", reason });
    }
  }

  /** Crawls one page and stores what it declares and what it lists. A crawl failure throws; storage failures are recorded. */
  private async fetchAndStore(
    ctx: RunContext,
    pageUrl: string,
    websiteStatus: string,
    allowedHosts?: string[],
  ): Promise<{ page: PageCrawlResult; stored: number; seenBefore: number }> {
    const page = await this.crawlPage(pageUrl, ctx.run.id, allowedHosts);
    ctx.run.progress.pagesCrawled += 1;
    const result = await this.storePage(ctx, page, websiteStatus);
    return { page, ...result };
  }

  /**
   * Stores one crawled page: its declared evidence, its page item, and its repeated cards. Items the brand already has are
   * counted as seen before and are not stored again.
   */
  private async storePage(
    ctx: RunContext,
    page: PageCrawlResult,
    sourceStatus: string,
  ): Promise<{ stored: number; seenBefore: number }> {
    const { run } = ctx;
    const provenance: RecordProvenance = {
      organizationId: run.organizationId,
      brandId: run.brandId,
      runId: run.id,
      adapterId: "website",
      sourceStatus,
    };
    const evidence = await persistPageEvidence(ctx.sql, provenance, page, run.perSourceErrors);
    run.progress.seenBefore = (run.progress.seenBefore ?? 0) + evidence.seenBefore;

    const canonicalUrl = canonicalPageKey(page.canonicalUrl || page.finalUrl);
    const topHash = contentHashOf([canonicalUrl, page.title, page.description]);
    const candidates: DiscoveredItem[] = [
      {
        id: `item_${run.id}_top_${topHash.slice(0, 16)}`,
        runId: run.id,
        url: page.finalUrl,
        canonicalUrl,
        source: "website",
        cardType: "article",
        title: page.title,
        text: page.description,
        mediaUrl: page.openGraph["og:image"] || page.openGraph["og:video"],
        metrics: unavailableMetrics(),
        contentHash: topHash,
        sourceLocation: page.finalUrl,
        discoveredAt: page.fetchedAt ?? new Date().toISOString(),
      },
      ...page.cards,
    ];

    let stored = 0;
    let itemsSeen = 0;
    for (const item of candidates) {
      if (ctx.seenHashes.has(item.contentHash)) continue;
      ctx.seenHashes.add(item.contentHash);
      const outcome = await this.persistItem(ctx, item, provenance);
      if (outcome === "stored") stored += 1;
      if (outcome === "seen_before") itemsSeen += 1;
    }
    return { stored, seenBefore: evidence.seenBefore + itemsSeen };
  }

  /**
   * Stores one item. An item that matches a stored one for the brand is `seen_before`. A failure is recorded under
   * `persist_` (or `source_` for the source row), so the run reports partial and does not claim the item is durable.
   */
  private async persistItem(ctx: RunContext, item: DiscoveredItem, provenance: RecordProvenance): Promise<ItemOutcome | "failed"> {
    const { run, sql } = ctx;
    try {
      const outcome = await storeDiscoveredItem(sql, provenance, item);
      if (outcome === "seen_before") {
        run.progress.seenBefore = (run.progress.seenBefore ?? 0) + 1;
        return outcome;
      }
      ctx.items.push(item);
      try {
        await upsertItemSource(sql, provenance, item);
      } catch (sourceErr) {
        run.perSourceErrors[`source_${item.id}`] = errorMessage(sourceErr);
      }
      return outcome;
    } catch (itemErr) {
      run.perSourceErrors[`persist_${item.id}`] = errorMessage(itemErr);
      return "failed";
    }
  }

  /** Niche, profile and URL-list runs: each planned source either runs for a seed or records why it did not. */
  private async discoverAcrossSources(ctx: RunContext): Promise<void> {
    const { run } = ctx;
    const plan = await ResearchPlanner.planResearch(this.registry, {
      organizationId: run.organizationId,
      scope: run.scope,
      seeds: run.seeds,
      budget: run.budget,
    });
    const websiteStatus = await this.healthStatusOf("website");

    for (const exec of plan.executions) {
      if (exec.status !== "eligible") {
        const reason = exec.reason || `Source ${exec.adapterId} not configured.`;
        run.perSourceErrors[exec.adapterId] = reason;
        recordSourceState(run, gateState(exec, reason));
        continue;
      }

      if (exec.adapterId === "website") {
        // Public pages are read from a URL or a bare domain. A free-text seed names no page, so nothing is read for it.
        const pageUrl = pageUrlForSeed(exec.seed);
        if (!pageUrl) {
          recordSourceState(run, {
            adapterId: "website",
            seed: exec.seed,
            status: "not_supported",
            reason: `"${exec.seed}" is free text, not a page URL or domain, so no page was read for it.`,
          });
          continue;
        }
        await this.scrapeSeed(ctx, exec.seed, pageUrl, websiteStatus, run.budget.allowedHosts);
        continue;
      }

      const adapter = this.registry.get(exec.adapterId);
      if (!adapter) {
        recordSourceState(run, {
          adapterId: exec.adapterId,
          seed: exec.seed,
          status: "not_configured",
          reason: `${exec.adapterId} is not registered.`,
        });
        continue;
      }

      const sourceStatus = exec.healthStatus ?? "UNKNOWN";
      const provenance: RecordProvenance = {
        organizationId: run.organizationId,
        brandId: run.brandId,
        runId: run.id,
        adapterId: adapter.id,
        sourceStatus,
      };
      try {
        const refs = await adapter.discover({
          organizationId: run.organizationId,
          query: exec.seed,
          niche: exec.seed,
          limit: run.budget.maxPages,
        });
        let itemsFound = 0;
        let seenBefore = 0;
        for (const ref of refs) {
          const item = itemFromReference(run.id, ref, exec.seed);
          if (ctx.seenHashes.has(item.contentHash)) continue;
          ctx.seenHashes.add(item.contentHash);
          const outcome = await this.persistItem(ctx, item, provenance);
          if (outcome === "stored") itemsFound += 1;
          if (outcome === "seen_before") seenBefore += 1;
        }
        recordSourceState(run, { adapterId: adapter.id, seed: exec.seed, status: "ran", itemsFound, seenBefore, sourceStatus });
      } catch (error) {
        const reason = errorMessage(error);
        run.perSourceErrors[exec.adapterId] = reason;
        recordSourceState(run, { adapterId: adapter.id, seed: exec.seed, status: "failed", reason });
        // Non-fatal for optional adapters (e.g. Cyclone): mission continues
      }
    }
  }

  /** The adapter's health status, or UNKNOWN when it cannot be read. Recorded on every item the run fetches from it. */
  private async healthStatusOf(adapterId: string, organizationId?: string): Promise<string> {
    const adapter = this.registry.get(adapterId);
    if (!adapter) return "UNKNOWN";
    try {
      return (await adapter.health(organizationId)).status;
    } catch {
      return "UNKNOWN";
    }
  }

  private async processDurableFrontier(
    ctx: RunContext,
    options: { maxPages: number; websiteStatus: string },
  ): Promise<FrontierOutcome> {
    const { sql, run } = ctx;
    const budget = run.budget;
    const workerId = `discovery-${randomUUID()}`;
    await DiscoveryFrontierService.recoverStaleDiscoveryWork(sql, {
      organizationId: run.organizationId,
      brandId: run.brandId,
    });

    while (run.progress.pagesCrawled < options.maxPages) {
      const current = await DiscoveryFrontierService.claimNextItem(sql, {
        organizationId: run.organizationId,
        brandId: run.brandId,
        runId: run.id,
        workerId,
        leaseSeconds: 90,
      });
      if (!current) break;
      const processing = await DiscoveryFrontierService.markProcessing(sql, {
        itemId: current.id, workerId, organizationId: run.organizationId, brandId: run.brandId, runId: run.id,
      });
      if (!processing) continue;

      const heartbeatTimer = setInterval(() => {
        void DiscoveryFrontierService.heartbeat(sql, {
          itemId: current.id, workerId, organizationId: run.organizationId, brandId: run.brandId, runId: run.id,
          leaseSeconds: 90,
        }).catch(() => undefined);
      }, 30_000);
      try {
        const { page, stored, seenBefore } = await this.fetchAndStore(ctx, current.url, options.websiteStatus, budget.allowedHosts);
        recordSourceState(run, {
          adapterId: "website", seed: current.url, status: "ran", itemsFound: stored, seenBefore, sourceStatus: options.websiteStatus,
        });
        await DiscoveryFrontierService.completeItem(sql, {
          itemId: current.id,
          workerId,
          organizationId: run.organizationId,
          brandId: run.brandId,
          runId: run.id,
          currentDepth: current.depth,
          maxDepth: budget.maxDepth,
          discoveredLinks: page.outboundLinks,
        });
      } catch (error) {
        const reason = errorMessage(error);
        run.perSourceErrors[current.url] = reason;
        recordSourceState(run, { adapterId: "website", seed: current.url, status: "failed", reason });
        await DiscoveryFrontierService.failItem(sql, {
          itemId: current.id,
          workerId,
          organizationId: run.organizationId,
          brandId: run.brandId,
          runId: run.id,
          error: reason,
        }).catch((leaseError) => {
          run.perSourceErrors[`frontier_${current.id}`] = errorMessage(leaseError);
        });
      } finally {
        clearInterval(heartbeatTimer);
      }
      run.progress.discoveredCards = ctx.items.filter((item) => item.source === "repeated_card_discovery").length;
      run.progress.discoveredUrls = ctx.items.length;
      await sql`
        update discovery_runs set progress = ${progressJson(run)},
          per_source_errors = ${JSON.stringify(run.perSourceErrors)}, updated_at = now()
        where id = ${run.id} and organization_id = ${run.organizationId} and brand_id = ${run.brandId}
      `;
    }

    const remaining = await sql<{ count: number }>`
      select count(*)::int as count from discovery_frontier
      where run_id = ${run.id} and organization_id = ${run.organizationId} and brand_id = ${run.brandId}
        and status in ('PENDING', 'RETRY', 'LEASED', 'PROCESSING')
    `;
    const terminalFailures = await sql<{ count: number }>`
      select count(*)::int as count from discovery_frontier
      where run_id = ${run.id} and organization_id = ${run.organizationId} and brand_id = ${run.brandId}
        and status = 'FAILED'
    `;
    return {
      remaining: Number(remaining[0]?.count || 0),
      terminalFailures: Number(terminalFailures[0]?.count || 0),
    };
  }

  /**
   * Sets the run's status and caveat from its source states. A run that paused, or whose pages failed terminally, is partial.
   * A run where every source that was called failed is failed. A run where no source was called (every source gated) is
   * completed, with a caveat that says no source ran, so the status alone is never the only signal.
   */
  private settle(ctx: RunContext, frontier: FrontierOutcome | undefined, fatal: boolean): void {
    const { run } = ctx;
    const sources = run.progress.sources ?? [];
    const { ran, failed } = summarize(sources);
    if (fatal) {
      run.status = "failed";
    } else if (frontier && frontier.remaining > 0) {
      run.status = "partial";
    } else if (failed > 0 && ran === 0) {
      run.status = "failed";
    } else if (failed > 0 || (frontier?.terminalFailures ?? 0) > 0 || hasPersistenceFailure(run.perSourceErrors)) {
      run.status = "partial";
    } else {
      run.status = "completed";
    }
    run.caveat = caveatFor(sources, run.progress.seenBefore ?? 0, frontier?.remaining);
  }

  async resumeDiscoveryRun(input: { organizationId: string; brandId: string; runId: string; sql: Sql }): Promise<DiscoveryRun> {
    const rows = await input.sql<Record<string, unknown>>`
      select * from discovery_runs
      where id = ${input.runId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
      limit 1
    `;
    const row = rows[0];
    if (!row) throw new Error("Discovery run not found.");
    const { progress, caveat } = progressFromRow(row.progress);
    const run: DiscoveryRun = {
      id: String(row.id), organizationId: input.organizationId, brandId: input.brandId,
      scope: row.scope as DiscoveryScope,
      seeds: parseJson<string[]>(row.seeds, []),
      budget: parseJson<CrawlBudget>(row.budget, { maxPages: 10, maxDepth: 2, concurrency: 2, delayMs: 100 }),
      status: "running",
      progress,
      caveat,
      perSourceErrors: parseJson<Record<string, string>>(row.per_source_errors, {}),
      startedAt: String(row.started_at),
    };
    const hashRows = await input.sql<{ content_hash: string }>`
      select content_hash from discovered_items
      where run_id = ${run.id} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
    `;
    const ctx: RunContext = { sql: input.sql, run, seenHashes: new Set(hashRows.map((item) => item.content_hash)), items: [] };
    const completedFrontier = await input.sql<{ count: number }>`
      select count(*)::int as count from discovery_frontier
      where run_id = ${run.id} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
        and status = 'COMPLETED'
    `;
    run.progress.pagesCrawled = Math.max(run.progress.pagesCrawled, Number(completedFrontier[0]?.count || 0));
    if (run.scope === "page_plus_links" || run.scope === "domain") {
      // A crash during the original seed enqueue leaves seeds missing. Re-enqueueing is idempotent,
      // so existing frontier rows are untouched and missing seeds are added.
      await DiscoveryFrontierService.enqueueLinks(input.sql, {
        organizationId: input.organizationId,
        brandId: input.brandId,
        runId: run.id,
        links: run.seeds.map((url) => ({ url, canonicalUrl: url, depth: 1, priority: 10 })),
      });
    }
    const frontier = await this.processDurableFrontier(ctx, {
      maxPages: run.scope === "page_plus_links" ? Math.min(run.budget.maxPages, 5) : run.budget.maxPages,
      websiteStatus: await this.healthStatusOf("website"),
    });
    this.settle(ctx, frontier, false);
    run.progress.discoveredCards = ctx.items.filter((item) => item.source === "repeated_card_discovery").length;
    run.progress.discoveredUrls = ctx.items.length;
    run.completedAt = run.status === "partial" ? undefined : new Date().toISOString();
    await input.sql`
      update discovery_runs set status = ${run.status}, progress = ${progressJson(run)},
        per_source_errors = ${JSON.stringify(run.perSourceErrors)}, completed_at = ${run.completedAt || null}, updated_at = now()
      where id = ${run.id} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
    `;
    return run;
  }

  async getDiscoveryRun(
    runIdOrInput: string | { runId: string; organizationId?: string; brandId?: string; sql?: Sql },
    sqlOrOptions?: Sql | { sql?: Sql; organizationId?: string; brandId?: string },
  ): Promise<DiscoveryRun | undefined> {
    const isInputObject = typeof runIdOrInput === "object" && runIdOrInput !== null;
    const runId = isInputObject ? runIdOrInput.runId : runIdOrInput;
    const sql = isInputObject
      ? runIdOrInput.sql || (typeof sqlOrOptions === "function" ? sqlOrOptions : sqlOrOptions?.sql)
      : typeof sqlOrOptions === "function" ? sqlOrOptions : sqlOrOptions?.sql;
    const organizationId = isInputObject
      ? runIdOrInput.organizationId
      : typeof sqlOrOptions === "object" && sqlOrOptions !== null ? sqlOrOptions.organizationId : undefined;
    const brandId = isInputObject
      ? runIdOrInput.brandId
      : typeof sqlOrOptions === "object" && sqlOrOptions !== null ? sqlOrOptions.brandId : undefined;

    if (!sql) throw new Error("Durable SQL and tenant scope are required to read a discovery run.");
    if (!organizationId || !brandId) {
      throw new Error("Tenant scope is required to read a durable discovery run.");
    }
    {
      const rows = await sql<Record<string, unknown>>`
        select * from discovery_runs
        where id = ${runId} and organization_id = ${organizationId} and brand_id = ${brandId}
        limit 1
      `;
      const row = rows[0];
      if (row) {
        const { progress, caveat } = progressFromRow(row.progress);
        return {
          id: String(row.id),
          organizationId: String(row.organization_id),
          brandId: String(row.brand_id),
          scope: row.scope as DiscoveryScope,
          seeds: parseJson<string[]>(row.seeds, []),
          budget: parseJson<CrawlBudget>(row.budget, { maxPages: 10, maxDepth: 2, concurrency: 2, delayMs: 100 }),
          status: row.status as DiscoveryRun["status"],
          progress,
          caveat,
          perSourceErrors: parseJson<Record<string, string>>(row.per_source_errors, {}),
          startedAt: String(row.started_at),
          completedAt: row.completed_at ? String(row.completed_at) : undefined,
        };
      }
      return undefined;
    }
  }

  async getDiscoveredItems(
    runIdOrInput: string | { runId: string; organizationId?: string; brandId?: string; sql?: Sql },
    sqlOrOptions?: Sql | { sql?: Sql; organizationId?: string; brandId?: string },
  ): Promise<DiscoveredItem[]> {
    const isInputObject = typeof runIdOrInput === "object" && runIdOrInput !== null;
    const runId = isInputObject ? runIdOrInput.runId : runIdOrInput;
    const sql = isInputObject
      ? runIdOrInput.sql || (typeof sqlOrOptions === "function" ? sqlOrOptions : sqlOrOptions?.sql)
      : typeof sqlOrOptions === "function" ? sqlOrOptions : sqlOrOptions?.sql;
    const organizationId = isInputObject
      ? runIdOrInput.organizationId
      : typeof sqlOrOptions === "object" && sqlOrOptions !== null ? sqlOrOptions.organizationId : undefined;
    const brandId = isInputObject
      ? runIdOrInput.brandId
      : typeof sqlOrOptions === "object" && sqlOrOptions !== null ? sqlOrOptions.brandId : undefined;

    if (!sql) throw new Error("Durable SQL and tenant scope are required to read discovery items.");
    if (!organizationId || !brandId) {
      throw new Error("Tenant scope is required to read durable discovery items.");
    }
    {
      const rows = await sql<Record<string, unknown>>`
        select * from discovered_items
        where run_id = ${runId} and organization_id = ${organizationId} and brand_id = ${brandId}
        order by discovered_at asc
      `;
      if (rows.length > 0) {
        return rows.map((row) => ({
          id: String(row.id),
          runId: String(row.run_id),
          url: String(row.url),
          canonicalUrl: row.canonical_url ? String(row.canonical_url) : String(row.url),
          source: String(row.source),
          cardType: (row.card_type as any) || "article",
          title: row.title ? String(row.title) : undefined,
          text: row.text_content ? String(row.text_content) : undefined,
          metrics: typeof row.metrics === "string" ? JSON.parse(row.metrics) : ((row.metrics as any) || {}),
          contentHash: String(row.content_hash),
          sourceLocation: row.source_location ? String(row.source_location) : String(row.url),
          discoveredAt: String(row.discovered_at),
        }));
      }
      return [];
    }
  }

  /**
   * Recovers stale discovery work (crashed workers or expired leases).
   */
  async recoverStaleWork(
    sql: Sql,
    options: {
      organizationId: string;
      brandId: string;
    }
  ) {
    return DiscoveryFrontierService.recoverStaleDiscoveryWork(sql, options);
  }
}

export const discoveryService = new DiscoveryService();
