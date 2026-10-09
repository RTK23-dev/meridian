/**
 * Discovery Service & Research Frontier
 *
 * Coordinates multi-page and whole-niche crawling, repeated card extraction,
 * deduplication, and integration with the universal SourceRegistry.
 */

import { randomUUID, createHash } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { sourceRegistry, SourceRegistry } from "../sources/registry.ts";
import { crawlLadderPage } from "./crawler.ts";
import { ResearchPlanner } from "./planner.ts";
import { DiscoveryFrontierService } from "./frontier.ts";
import type {
  DiscoveryScope,
  DiscoveryRun,
  DiscoveredItem,
  CrawlBudget,
} from "./types.ts";

export type PageCrawler = typeof crawlLadderPage;

/**
 * True when any discovered item was not fully stored. Such a run cannot report `completed`, because
 * the caller would otherwise believe every discovered item is durable.
 */
function hasPersistenceFailure(errors: Record<string, string>): boolean {
  return Object.keys(errors).some((key) => key.startsWith("persist_") || key.startsWith("source_"));
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
      },
      perSourceErrors: {},
      startedAt: new Date().toISOString(),
    };

    {
      const sql = input.sql;
      await sql`
        insert into discovery_runs (
          id, organization_id, brand_id, scope, status, seeds, budget, progress, per_source_errors, started_at
        ) values (
          ${runId}, ${input.organizationId}, ${input.brandId}, ${input.scope}, 'running',
          ${JSON.stringify(input.seeds)}, ${JSON.stringify(budget)}, ${JSON.stringify(run.progress)},
          ${JSON.stringify(run.perSourceErrors)}, now()
        )
      `;
    }

    const discoveredItems: DiscoveredItem[] = [];
    const seenHashes = new Set<string>();
    let crawlFailures = 0;

    const persistItem = async (item: DiscoveredItem) => {
      discoveredItems.push(item);
      {
        try {
          await input.sql`
            insert into discovered_items (
              id, run_id, organization_id, brand_id, source, url, canonical_url,
              card_type, title, text_content, metrics, content_hash, source_location, discovered_at
            ) values (
              ${item.id}, ${runId}, ${input.organizationId}, ${input.brandId},
              ${item.source}, ${item.url}, ${item.canonicalUrl || null},
              ${item.cardType}, ${item.title || null}, ${item.text || null},
              ${JSON.stringify(item.metrics || {})}, ${item.contentHash},
              ${item.sourceLocation || null}, now()
            )
            on conflict (id) do nothing
          `;

          const sourceId = `src_${item.id}`;
          await input.sql`
            insert into sources (
              id, organization_id, brand_id, platform, adapter_id, external_id,
              canonical_url, name, status, metadata, created_at, updated_at
            ) values (
              ${sourceId}, ${input.organizationId}, ${input.brandId}, ${item.source},
              ${item.source}, ${item.id}, ${item.canonicalUrl || item.url},
              ${(item.title || item.canonicalUrl || item.id).slice(0, 100)}, 'ready', ${JSON.stringify(item)}, now(), now()
            )
            on conflict (organization_id, platform, external_id) do update set
              canonical_url = excluded.canonical_url,
              metadata = excluded.metadata,
              updated_at = now()
          `;
        } catch (itemErr: any) {
          run.perSourceErrors[`persist_${item.id}`] = itemErr.message || String(itemErr);
        }
      }
    };

    try {
      if (input.scope === "scrape_page") {
        for (const seed of input.seeds) {
          try {
            const pageResult = await this.crawlPage(seed, runId);
            run.progress.pagesCrawled++;

            // Top-level page record
            const topHash = createHash("sha256").update(pageResult.title + pageResult.description).digest("hex");
            if (!seenHashes.has(topHash)) {
              seenHashes.add(topHash);
              await persistItem({
                id: `item_${runId}_top_${discoveredItems.length}`,
                runId,
                url: pageResult.finalUrl,
                canonicalUrl: pageResult.canonicalUrl,
                source: "website",
                cardType: "article",
                title: pageResult.title,
                text: pageResult.description,
                mediaUrl: pageResult.openGraph["og:image"] || pageResult.openGraph["og:video"],
                metrics: {
                  views: { value: null, state: "UNAVAILABLE" },
                  likes: { value: null, state: "UNAVAILABLE" },
                  comments: { value: null, state: "UNAVAILABLE" },
                },
                contentHash: topHash,
                sourceLocation: pageResult.finalUrl,
                discoveredAt: new Date().toISOString(),
              });
            }

            // Repeated cards on the page
            for (const card of pageResult.cards) {
              if (!seenHashes.has(card.contentHash)) {
                seenHashes.add(card.contentHash);
                await persistItem(card);
              }
            }
          } catch (err) {
            run.perSourceErrors[seed] = err instanceof Error ? err.message : String(err);
            crawlFailures += 1;
          }
        }

        run.status = crawlFailures > 0 && run.progress.pagesCrawled === 0
          ? "failed"
          : crawlFailures > 0 || hasPersistenceFailure(run.perSourceErrors) ? "partial" : "completed";
      } else if (input.scope === "page_plus_links" || input.scope === "domain") {
        if (input.sql) {
          await DiscoveryFrontierService.enqueueLinks(input.sql, {
            organizationId: input.organizationId,
            brandId: input.brandId,
            runId,
            links: input.seeds.map((url) => ({ url, canonicalUrl: url, depth: 1, priority: 10 })),
          });
          const storedItems = await input.sql<{ content_hash: string }>`
            select content_hash from discovered_items
            where run_id = ${runId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
          `;
          for (const row of storedItems) seenHashes.add(row.content_hash);
          await this.processDurableFrontier({
            sql: input.sql, run, budget, maxPages: input.scope === "page_plus_links" ? Math.min(budget.maxPages, 5) : budget.maxPages,
            items: discoveredItems, seenHashes,
          });
        }
      } else {
        // Niche, Profile, or URL List - leverage ResearchPlanner across registered adapters
        const plan = await ResearchPlanner.planResearch(this.registry, {
          scope: input.scope,
          seeds: input.seeds,
          budget,
        });

        let adaptersRun = 0;
        let adapterFailures = 0;
        for (const exec of plan.executions) {
          if (exec.status !== "eligible") {
            run.perSourceErrors[exec.adapterId] = exec.reason || `Source ${exec.adapterId} not configured.`;
            continue;
          }

          const adapter = this.registry.get(exec.adapterId);
          if (!adapter) continue;
          adaptersRun += 1;

          try {
            const refs = await adapter.discover({
              query: exec.seed,
              niche: exec.seed,
              limit: budget.maxPages,
            });
            for (const ref of refs) {
              const itemHash = createHash("sha256").update(ref.sourceId + (ref.canonicalUrl || "")).digest("hex");
              if (!seenHashes.has(itemHash)) {
                seenHashes.add(itemHash);
                await persistItem({
                  id: `item_${runId}_${discoveredItems.length}`,
                  runId,
                  url: ref.canonicalUrl || exec.seed,
                  canonicalUrl: ref.canonicalUrl || exec.seed,
                  source: ref.platform,
                  cardType: "post",
                  title: (ref.metadata?.handle as string) || (ref.metadata?.caption as string) || ref.canonicalUrl || exec.seed,
                  text: (ref.metadata?.caption as string) || undefined,
                  metrics: {
                    views: { value: null, state: "UNAVAILABLE" },
                    likes: { value: null, state: "UNAVAILABLE" },
                    comments: { value: null, state: "UNAVAILABLE" },
                  },
                  contentHash: itemHash,
                  sourceLocation: exec.seed,
                  discoveredAt: new Date().toISOString(),
                });
              }
            }
          } catch (err) {
            run.perSourceErrors[exec.adapterId] = err instanceof Error ? err.message : String(err);
            adapterFailures += 1;
            // Non-fatal for optional adapters (e.g. Cyclone): mission continues
          }
        }
        run.status = adaptersRun > 0 && adapterFailures === adaptersRun && discoveredItems.length === 0
          ? "failed"
          : adapterFailures > 0 || hasPersistenceFailure(run.perSourceErrors) ? "partial" : "completed";
      }
    } catch (fatalErr) {
      run.status = "failed";
      run.perSourceErrors["global"] = fatalErr instanceof Error ? fatalErr.message : String(fatalErr);
    }

    run.completedAt = new Date().toISOString();
    run.progress.discoveredCards = discoveredItems.filter((i) => i.source === "repeated_card_discovery").length;
    run.progress.discoveredUrls = discoveredItems.length;

    // Durable DB run status persistence if SQL provided
    {
      try {
        const sql = input.sql;
        await sql`
          update discovery_runs
          set status = ${run.status}, progress = ${JSON.stringify(run.progress)},
              per_source_errors = ${JSON.stringify(run.perSourceErrors)},
              completed_at = now(), updated_at = now()
          where id = ${runId}
        `;
      } catch (dbErr: any) {
        run.status = "failed";
        run.perSourceErrors["database_persistence"] = dbErr.message || String(dbErr);
      }
    }

    return {
      run,
      items: discoveredItems,
    };
  }

  private async processDurableFrontier(input: {
    sql: Sql;
    run: DiscoveryRun;
    budget: CrawlBudget;
    maxPages: number;
    items: DiscoveredItem[];
    seenHashes: Set<string>;
    workerId?: string;
  }): Promise<void> {
    const workerId = input.workerId || `discovery-${randomUUID()}`;
    const { sql, run, budget, items, seenHashes } = input;
    await DiscoveryFrontierService.recoverStaleDiscoveryWork(sql, {
      organizationId: run.organizationId,
      brandId: run.brandId,
    });

    while (run.progress.pagesCrawled < input.maxPages) {
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
        const pageResult = await this.crawlPage(current.url, run.id, budget.allowedHosts);
        run.progress.pagesCrawled += 1;
        const topHash = createHash("sha256").update(pageResult.title + pageResult.description).digest("hex");
        const pageItems: DiscoveredItem[] = [];
        if (!seenHashes.has(topHash)) {
          seenHashes.add(topHash);
          pageItems.push({
            id: `item_${run.id}_top_${topHash}`,
            runId: run.id,
            url: pageResult.finalUrl,
            canonicalUrl: pageResult.canonicalUrl,
            source: "website",
            cardType: "article",
            title: pageResult.title,
            text: pageResult.description,
            mediaUrl: pageResult.openGraph["og:image"] || pageResult.openGraph["og:video"],
            metrics: {
              views: { value: null, state: "UNAVAILABLE" },
              likes: { value: null, state: "UNAVAILABLE" },
              comments: { value: null, state: "UNAVAILABLE" },
            },
            contentHash: topHash,
            sourceLocation: pageResult.finalUrl,
            discoveredAt: new Date().toISOString(),
          });
        }
        for (const card of pageResult.cards) {
          if (!seenHashes.has(card.contentHash)) {
            seenHashes.add(card.contentHash);
            pageItems.push(card);
          }
        }
        for (const item of pageItems) {
          await sql`
            insert into discovered_items (
              id, run_id, organization_id, brand_id, source, url, canonical_url,
              card_type, title, text_content, metrics, content_hash, source_location, discovered_at
            ) values (
              ${item.id}, ${run.id}, ${run.organizationId}, ${run.brandId}, ${item.source}, ${item.url},
              ${item.canonicalUrl || null}, ${item.cardType}, ${item.title || null}, ${item.text || null},
              ${JSON.stringify(item.metrics || {})}, ${item.contentHash}, ${item.sourceLocation || null}, now()
            ) on conflict (id) do nothing
          `;
          items.push(item);
          try {
            await sql`
              insert into sources (
                id, organization_id, brand_id, platform, adapter_id, external_id,
                canonical_url, name, status, metadata, created_at, updated_at
              ) values (
                ${`src_${item.id}`}, ${run.organizationId}, ${run.brandId}, ${item.source}, ${item.source},
                ${item.id}, ${item.canonicalUrl || item.url}, ${(item.title || item.canonicalUrl || item.id).slice(0, 100)},
                'ready', ${JSON.stringify(item)}, now(), now()
              ) on conflict (organization_id, platform, external_id) do update set
                canonical_url = excluded.canonical_url, metadata = excluded.metadata, updated_at = now()
            `;
          } catch (error) {
            run.perSourceErrors[`source_${item.id}`] = error instanceof Error ? error.message : String(error);
          }
        }
        await DiscoveryFrontierService.completeItem(sql, {
          itemId: current.id,
          workerId,
          organizationId: run.organizationId,
          brandId: run.brandId,
          runId: run.id,
          currentDepth: current.depth,
          maxDepth: budget.maxDepth,
          discoveredLinks: pageResult.outboundLinks,
        });
      } catch (error) {
        run.perSourceErrors[current.url] = error instanceof Error ? error.message : String(error);
        await DiscoveryFrontierService.failItem(sql, {
          itemId: current.id,
          workerId,
          organizationId: run.organizationId,
          brandId: run.brandId,
          runId: run.id,
          error: run.perSourceErrors[current.url]!,
        }).catch((leaseError) => {
          run.perSourceErrors[`frontier_${current.id}`] = leaseError instanceof Error ? leaseError.message : String(leaseError);
        });
      } finally {
        clearInterval(heartbeatTimer);
      }
      run.progress.discoveredCards = items.filter((item) => item.source === "repeated_card_discovery").length;
      run.progress.discoveredUrls = items.length;
      await sql`
        update discovery_runs set progress = ${JSON.stringify(run.progress)},
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
    if (Number(remaining[0]?.count || 0) > 0) {
      run.status = "partial";
      run.caveat = `Crawl paused with ${remaining[0]?.count || 0} durable frontier item(s) remaining.`;
    } else if (run.progress.pagesCrawled === 0 && Object.keys(run.perSourceErrors).length) {
      run.status = "failed";
    } else {
      // A page that failed terminally was never crawled, so the run is partial, not completed.
      const failedItems = Number(terminalFailures[0]?.count || 0);
      run.status = failedItems > 0 || hasPersistenceFailure(run.perSourceErrors) ? "partial" : "completed";
    }
  }

  async resumeDiscoveryRun(input: { organizationId: string; brandId: string; runId: string; sql: Sql }): Promise<DiscoveryRun> {
    const rows = await input.sql<Record<string, unknown>>`
      select * from discovery_runs
      where id = ${input.runId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
      limit 1
    `;
    const row = rows[0];
    if (!row) throw new Error("Discovery run not found.");
    const parse = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) as T : value as T;
    const run: DiscoveryRun = {
      id: String(row.id), organizationId: input.organizationId, brandId: input.brandId,
      scope: row.scope as DiscoveryScope, seeds: parse<string[]>(row.seeds), budget: parse<CrawlBudget>(row.budget),
      status: "running", progress: parse<DiscoveryRun["progress"]>(row.progress),
      perSourceErrors: parse<Record<string, string>>(row.per_source_errors), startedAt: String(row.started_at),
    };
    const rowsItems = await input.sql<Record<string, unknown>>`
      select id, url, canonical_url, source, card_type, title, text_content, metrics, content_hash, source_location, discovered_at
      from discovered_items where run_id = ${run.id} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
      order by discovered_at asc
    `;
    const items: DiscoveredItem[] = rowsItems.map((item) => ({
      id: String(item.id), runId: run.id, url: String(item.url), canonicalUrl: String(item.canonical_url || item.url),
      source: String(item.source), cardType: String(item.card_type || "article") as DiscoveredItem["cardType"],
      title: item.title ? String(item.title) : undefined, text: item.text_content ? String(item.text_content) : undefined,
      metrics: parse(item.metrics || {}), contentHash: String(item.content_hash),
      sourceLocation: String(item.source_location || item.url), discoveredAt: String(item.discovered_at),
    }));
    const completedFrontier = await input.sql<{ count: number }>`
      select count(*)::int as count from discovery_frontier
      where run_id = ${run.id} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
        and status = 'COMPLETED'
    `;
    run.progress.pagesCrawled = Math.max(run.progress.pagesCrawled, Number(completedFrontier[0]?.count || 0));
    const hashes = new Set(items.map((item) => item.contentHash));
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
    await this.processDurableFrontier({
      sql: input.sql,
      run,
      budget: run.budget,
      maxPages: run.scope === "page_plus_links" ? Math.min(run.budget.maxPages, 5) : run.budget.maxPages,
      items,
      seenHashes: hashes,
    });
    run.completedAt = run.status === "partial" ? undefined : new Date().toISOString();
    await input.sql`
      update discovery_runs set status = ${run.status}, progress = ${JSON.stringify(run.progress)},
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
        return {
          id: String(row.id),
          organizationId: String(row.organization_id),
          brandId: String(row.brand_id),
          scope: row.scope as any,
          seeds: typeof row.seeds === "string" ? JSON.parse(row.seeds) : (row.seeds as any),
          budget: typeof row.budget === "string" ? JSON.parse(row.budget) : (row.budget as any),
          status: row.status as any,
          progress: typeof row.progress === "string" ? JSON.parse(row.progress) : (row.progress as any),
          perSourceErrors: typeof row.per_source_errors === "string" ? JSON.parse(row.per_source_errors) : ((row.per_source_errors as any) || {}),
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
