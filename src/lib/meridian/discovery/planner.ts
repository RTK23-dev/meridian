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
import { pageUrlForSeed } from "../sources/public-url.ts";
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
export const MULTI_SOURCE_ADAPTERS = [
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

/** The names shown for the keyed sources on the Market screen. */
export const DISCOVERY_SOURCE_LABELS: Record<string, string> = {
  youtube: "YouTube",
  search: "Google search (SerpAPI)",
  meta_ad_library: "Meta Ad Library",
  tiktok: "TikTok",
  instagram: "Instagram",
  twitter: "X (Twitter)",
  facebook: "Facebook",
  pinterest: "Pinterest",
  linkedin: "LinkedIn",
  reddit: "Reddit",
  licensed: "Licensed data",
};

export interface DiscoverySourceStatus {
  adapterId: string;
  label: string;
  /** The health the adapter reports for this workspace. `failed` means the health check itself threw. */
  status: SourceHealth["status"] | "failed";
  /** The resolver's reason, or the adapter's own explanation. Empty when the source is connected. */
  reason: string;
  /** True when a key is saved for the workspace and the adapter runs discovery with it. */
  connected: boolean;
}

/**
 * Each keyed source's health for one workspace, for the Market screen. A source is connected only when its health is
 * CONFIGURED or HEALTHY, which is key presence. Nothing here makes a provider request.
 */
export async function discoverySourceStatuses(registry: SourceRegistry, organizationId: string): Promise<DiscoverySourceStatus[]> {
  const statuses: DiscoverySourceStatus[] = [];
  for (const adapterId of MULTI_SOURCE_ADAPTERS) {
    const adapter = registry.get(adapterId);
    if (!adapter) continue;
    const health = await adapter.health(organizationId).catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    const planned = planFromHealth(health, adapter.id);
    const connected = !("error" in health) && (health.status === "CONFIGURED" || health.status === "HEALTHY");
    statuses.push({
      adapterId: adapter.id,
      label: DISCOVERY_SOURCE_LABELS[adapter.id] ?? adapter.id,
      status: "error" in health ? "failed" : health.status,
      reason: connected ? "" : (planned.reason ?? ""),
      connected,
    });
  }
  return statuses;
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
        const namesPage = pageUrlForSeed(seed) !== null;
        for (const adapterId of MULTI_SOURCE_ADAPTERS) {
          const adapter = registry.get(adapterId);
          if (!adapter) continue;
          const health = await adapter.health(request.organizationId).catch((error: unknown) => ({
            error: error instanceof Error ? error.message : String(error),
          }));
          const planned = planFromHealth(health, adapter.id);
          // A seed that names a page is read directly. A phrase search for it would store results that do not belong to it.
          if (planned.status === "eligible" && namesPage) {
            executions.push({
              adapterId: adapter.id,
              sourceKind: adapter.platform,
              seed,
              isOptional: true,
              status: "not_supported",
              reason: `"${seed}" names a page, which is read directly. ${adapter.id} searches by phrase, so no search is run for it.`,
              healthStatus: planned.healthStatus,
            });
            continue;
          }
          executions.push({
            adapterId: adapter.id,
            sourceKind: adapter.platform,
            seed,
            isOptional: true,
            ...planned,
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
