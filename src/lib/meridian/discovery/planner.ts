/**
 * Meridian Research Planner
 *
 * Implements Section P1.3, P1.4:
 * Multi-source research orchestrator that plans eligible source adapters
 * according to scope, available credentials, and enabled sources.
 *
 * Principles:
 * - Scopes: scrape_page, page_plus_links, domain, and scrape_niche.
 * - Cyclone is strictly optional supplemental observation; standard discovery
 *   runs fully with Cyclone absent and all Cyclone env vars unset.
 * - Every registered multi-source adapter is planned for each seed, so a keyed source with no saved key is listed as
 *   not configured with its reason. It is never dropped silently.
 * - Distinct source status: not configured, not supported, failed, and eligible. Zero results is not a status here.
 */

import type { SourceRegistry } from "../sources/registry.ts";
import type { SourceHealth } from "../sources/types.ts";
import type { DiscoveryScope, CrawlBudget } from "./types.ts";

export interface ResearchPlanRequest {
  /** The workspace whose saved source keys the planned sources may use. */
  organizationId?: string;
  scope: DiscoveryScope;
  seeds: string[];
  enabledSources?: string[];
  budget?: Partial<CrawlBudget>;
  includeCycloneIfAvailable?: boolean;
}

export interface PlannedSourceExecution {
  adapterId: string;
  sourceKind: string;
  seed: string;
  isOptional: boolean;
  status: "eligible" | "not_configured" | "not_supported" | "failed" | "skipped_by_policy";
  /** Why the source is not eligible. For a gated source this is the resolver's reason, or the adapter's own explanation. */
  reason?: string;
  /** The adapter's health status at planning time, for an eligible source. */
  healthStatus?: string;
}

export interface ResearchPlan {
  id: string;
  scope: DiscoveryScope;
  executions: PlannedSourceExecution[];
  budget: CrawlBudget;
  cycloneIncluded: boolean;
  createdAt: string;
}

/** Adapters planned for niche, profile and URL-list scopes. Each reports its own gate; none is assumed connected. */
const MULTI_SOURCE_ADAPTERS = [
  "meta_ad_library",
  "tiktok",
  "youtube",
  "instagram",
  "twitter",
  "facebook",
  "pinterest",
  "linkedin",
  "reddit",
  "search",
  "licensed",
] as const;

/** Maps an adapter's health to a planned status. A health check that throws is a failure, with its message. */
function planFromHealth(health: SourceHealth | { error: string }, adapterId: string): Pick<PlannedSourceExecution, "status" | "reason" | "healthStatus"> {
  if ("error" in health) {
    return { status: "failed", reason: `Health check failed for ${adapterId}: ${health.error}` };
  }
  if (health.status === "HEALTHY" || health.status === "CONFIGURED") {
    return { status: "eligible", healthStatus: health.status };
  }
  if (health.status === "NOT_CONFIGURED") {
    return { status: "not_configured", reason: health.message || `${adapterId} is not configured.`, healthStatus: health.status };
  }
  if (health.status === "NOT_SUPPORTED") {
    return { status: "not_supported", reason: health.message || `${adapterId} is not supported in this release.`, healthStatus: health.status };
  }
  return { status: "failed", reason: health.message || `${adapterId} status: ${health.status}`, healthStatus: health.status };
}

export class ResearchPlanner {
  static async planResearch(
    registry: SourceRegistry,
    request: ResearchPlanRequest,
  ): Promise<ResearchPlan> {
    const planId = `rplan_${globalThis.crypto.randomUUID()}`;
    const scope = request.scope;
    const executions: PlannedSourceExecution[] = [];

    const budget: CrawlBudget = {
      maxPages: Math.min(Math.max(1, request.budget?.maxPages || 10), 100),
      maxDepth: Math.min(Math.max(1, request.budget?.maxDepth || 2), 5),
      concurrency: Math.min(Math.max(1, request.budget?.concurrency || 2), 5),
      allowedHosts: request.budget?.allowedHosts,
      delayMs: request.budget?.delayMs || 100,
    };

    if (scope === "scrape_page" || scope === "page_plus_links" || scope === "domain") {
      // Direct Web Crawling steps
      for (const seed of request.seeds) {
        executions.push({
          adapterId: "website",
          sourceKind: "website",
          seed,
          isOptional: false,
          status: "eligible",
        });
      }
    } else {
      // scrape_niche / profile / url_list multi-source orchestration
      for (const seed of request.seeds) {
        // 1. Website pages. The run reads a seed only when it names a page; a free-text seed is reported per source.
        if (registry.get("website")) {
          executions.push({
            adapterId: "website",
            sourceKind: "website",
            seed,
            isOptional: false,
            status: "eligible",
            healthStatus: "HEALTHY",
          });
        }

        // 2. Keyed and public-platform adapters. Each health check is scoped to the workspace.
        for (const adapterId of MULTI_SOURCE_ADAPTERS) {
          const adapter = registry.get(adapterId);
          if (!adapter) continue;
          const health = await adapter.health(request.organizationId).catch((error: unknown) => ({
            error: error instanceof Error ? error.message : String(error),
          }));
          executions.push({
            adapterId: adapter.id,
            sourceKind: adapter.platform,
            seed,
            isOptional: true,
            ...planFromHealth(health, adapter.id),
          });
        }

        // 3. Optional Cyclone Scout supplemental observation
        const cycloneAdapter = registry.get("cyclone_scout");
        if (cycloneAdapter && request.includeCycloneIfAvailable !== false) {
          const health = await cycloneAdapter.health().catch(() => ({ status: "NOT_CONFIGURED" as const }));
          const isConnected = health.status === "HEALTHY" || health.status === "CONFIGURED";
          executions.push({
            adapterId: "cyclone_scout",
            sourceKind: "cyclone_scout",
            seed,
            isOptional: true, // Always optional! Never blocks discovery.
            status: isConnected ? "eligible" : "not_configured",
            reason: isConnected ? undefined : `Cyclone scout not connected or configured (${health.status})`,
          });
        }
      }
    }

    const cycloneIncluded = executions.some(
      (e) => e.adapterId === "cyclone_scout" && e.status === "eligible",
    );

    return {
      id: planId,
      scope,
      executions,
      budget,
      cycloneIncluded,
      createdAt: new Date().toISOString(),
    };
  }
}
