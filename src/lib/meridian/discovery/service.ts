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

const inMemoryRuns = new Map<string, DiscoveryRun>();
const inMemoryItems = new Map<string, DiscoveredItem[]>();

export class DiscoveryService {
  private registry: SourceRegistry;

  constructor(registry: SourceRegistry = sourceRegistry) {
    this.registry = registry;
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
    sql?: Sql;
  }): Promise<{
    run: DiscoveryRun;
    items: DiscoveredItem[];
  }> {
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

    inMemoryRuns.set(runId, run);

    if (input.sql) {
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
    const seenUrls = new Set<string>();
    const seenHashes = new Set<string>();

    const persistItem = async (item: DiscoveredItem) => {
      discoveredItems.push(item);
      if (input.sql) {
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
            const pageResult = await crawlLadderPage(seed, runId);
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
          }
        }

        run.status = Object.keys(run.perSourceErrors).length > 0 && run.progress.pagesCrawled === 0 ? "failed" : "completed";
      } else if (input.scope === "page_plus_links" || input.scope === "domain") {
        // Frontier queue for BFS crawl ladder
        const queue: Array<{ url: string; depth: number }> = input.seeds.map((s) => ({ url: s, depth: 1 }));
        const maxPages = input.scope === "page_plus_links" ? Math.min(budget.maxPages, 5) : budget.maxPages;

        while (queue.length > 0 && run.progress.pagesCrawled < maxPages) {
          const current = queue.shift()!;
          if (seenUrls.has(current.url)) continue;
          seenUrls.add(current.url);

          try {
            const pageResult = await crawlLadderPage(current.url, runId, budget.allowedHosts);
            run.progress.pagesCrawled++;

            // Top-level page item
            const topHash = createHash("sha256").update(pageResult.title + pageResult.description).digest("hex");
            if (!seenHashes.has(topHash)) {
              seenHashes.add(topHash);
              await persistItem({
                id: `item_${runId}_${discoveredItems.length}`,
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

            // Repeated cards on this page
            for (const card of pageResult.cards) {
              if (!seenHashes.has(card.contentHash)) {
                seenHashes.add(card.contentHash);
                await persistItem(card);
              }
            }

            // Enqueue outbound links if depth permits
            if (current.depth < budget.maxDepth) {
              for (const nextLink of pageResult.outboundLinks) {
                if (!seenUrls.has(nextLink)) {
                  queue.push({ url: nextLink, depth: current.depth + 1 });
                }
              }
            }
          } catch (err) {
            run.perSourceErrors[current.url] = err instanceof Error ? err.message : String(err);
          }
        }

        if (queue.length > 0 && run.progress.pagesCrawled >= maxPages) {
          run.caveat = `Crawl reached maximum page budget of ${maxPages} before exhausting all frontier links.`;
          run.status = "partial";
        } else {
          run.status = "completed";
        }
      } else {
        // Niche, Profile, or URL List - leverage ResearchPlanner across registered adapters
        const plan = await ResearchPlanner.planResearch(this.registry, {
          scope: input.scope,
          seeds: input.seeds,
          budget,
        });

        for (const exec of plan.executions) {
          if (exec.status !== "eligible") {
            run.perSourceErrors[exec.adapterId] = exec.reason || `Source ${exec.adapterId} not configured.`;
            continue;
          }

          const adapter = this.registry.get(exec.adapterId);
          if (!adapter) continue;

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
            // Non-fatal for optional adapters (e.g. Cyclone): mission continues
          }
        }
        run.status = "completed";
      }
    } catch (fatalErr) {
      run.status = "failed";
      run.perSourceErrors["global"] = fatalErr instanceof Error ? fatalErr.message : String(fatalErr);
    }

    run.completedAt = new Date().toISOString();
    run.progress.discoveredCards = discoveredItems.filter((i) => i.source === "repeated_card_discovery").length;
    run.progress.discoveredUrls = discoveredItems.length;

    // Durable DB run status persistence if SQL provided
    if (input.sql) {
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

    inMemoryRuns.set(runId, run);
    inMemoryItems.set(runId, discoveredItems);

    return {
      run,
      items: discoveredItems,
    };
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

    if (sql) {
      let rows: Record<string, unknown>[];
      if (organizationId && brandId) {
        rows = await sql<Record<string, unknown>>`
          select * from discovery_runs
          where id = ${runId} and organization_id = ${organizationId} and brand_id = ${brandId}
          limit 1
        `;
      } else {
        rows = await sql<Record<string, unknown>>`
          select * from discovery_runs where id = ${runId} limit 1
        `;
      }
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
    }
    return inMemoryRuns.get(runId);
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

    if (sql) {
      let rows: Record<string, unknown>[];
      if (organizationId && brandId) {
        rows = await sql<Record<string, unknown>>`
          select * from discovered_items
          where run_id = ${runId} and organization_id = ${organizationId} and brand_id = ${brandId}
          order by discovered_at asc
        `;
      } else {
        rows = await sql<Record<string, unknown>>`
          select * from discovered_items where run_id = ${runId} order by discovered_at asc
        `;
      }
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
    }
    return inMemoryItems.get(runId) || [];
  }

  /**
   * Recovers stale discovery work (crashed workers or expired leases).
   */
  async recoverStaleWork(
    sql: Sql,
    options?: {
      organizationId?: string;
      brandId?: string;
    }
  ) {
    return DiscoveryFrontierService.recoverStaleDiscoveryWork(sql, options);
  }
}

export const discoveryService = new DiscoveryService();
