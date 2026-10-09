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
 * - Distinct source status: unavailable, not configured, blocked, failed vs zero results.
 */

import type { SourceRegistry } from "../sources/registry.ts";
import type { DiscoveryScope, CrawlBudget } from "./types.ts";

export interface ResearchPlanRequest {
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
  status: "eligible" | "not_configured" | "skipped_by_policy";
  reason?: string;
}

export interface ResearchPlan {
  id: string;
  scope: DiscoveryScope;
  executions: PlannedSourceExecution[];
  budget: CrawlBudget;
  cycloneIncluded: boolean;
  createdAt: string;
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
        // 1. Website crawler / search
        const webAdapter = registry.get("website");
        if (webAdapter) {
          executions.push({
            adapterId: "website",
            sourceKind: "website",
            seed,
            isOptional: false,
            status: "eligible",
          });
        }

        // 2. Meta Ad Library adapter
        const metaAdapter = registry.get("meta_ad_library");
        if (metaAdapter) {
          const health = await metaAdapter.health().catch(() => ({ status: "UNAVAILABLE" as const }));
          const isEligible = health.status === "HEALTHY" || health.status === "CONFIGURED";
          executions.push({
            adapterId: "meta_ad_library",
            sourceKind: "meta_ad_library",
            seed,
            isOptional: true,
            status: isEligible ? "eligible" : "not_configured",
            reason: isEligible ? undefined : `Meta Ad Library status: ${health.status}`,
          });
        }

        // 3. Social / Video adapters (TikTok, YouTube)
        for (const platform of ["tiktok", "youtube"] as const) {
          const adapter = registry.get(platform);
          if (adapter) {
            const health = await adapter.health().catch(() => ({ status: "UNAVAILABLE" as const }));
            const isEligible = health.status === "HEALTHY" || health.status === "CONFIGURED";
            executions.push({
              adapterId: adapter.id,
              sourceKind: platform,
              seed,
              isOptional: true,
              status: isEligible ? "eligible" : "not_configured",
              reason: isEligible ? undefined : `${platform} adapter status: ${health.status}`,
            });
          }
        }

        // 4. Optional Cyclone Scout supplemental observation
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
