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

    const discoveredItems: DiscoveredItem[] = [];
    const seenUrls = new Set<string>();
    const seenHashes = new Set<string>();

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
              discoveredItems.push({
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
                discoveredItems.push(card);
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
              discoveredItems.push({
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
                discoveredItems.push(card);
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
                discoveredItems.push({
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

    // Durable DB persistence if SQL provided
    if (input.sql) {
      try {
        const sql = input.sql;
        for (const item of discoveredItems) {
          const sourceId = `src_${item.id}`;
          await sql`
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
        }
      } catch {
        // Graceful error handling for DB persistence
      }
    }

    inMemoryRuns.set(runId, run);
    inMemoryItems.set(runId, discoveredItems);

    return {
      run,
      items: discoveredItems,
    };
  }

  getDiscoveryRun(runId: string): DiscoveryRun | undefined {
    return inMemoryRuns.get(runId);
  }

  getDiscoveredItems(runId: string): DiscoveredItem[] {
    return inMemoryItems.get(runId) || [];
  }
}

export const discoveryService = new DiscoveryService();
