/**
 * Provider-Neutral Production Router
 *
 * Directs creative rendering jobs to the optimal production provider based on
 * tenant cost modes: ZERO_SPEND, LOWEST_COST, BALANCED, QUALITY_FIRST.
 */

import type {
  CostMode,
  CreativeSpec,
  ProductionProvider,
} from "./types.ts";
import { ManualCloudProvider } from "./providers/manual-cloud.ts";
import { HypitProvider } from "./providers/hypit.ts";
import { VeoProvider } from "./providers/veo.ts";
import { HiggsfieldProvider } from "./providers/higgsfield.ts";

export class ProductionRouter {
  private providers = new Map<string, ProductionProvider>();

  constructor() {
    this.register(new ManualCloudProvider());
    this.register(new HypitProvider());
    this.register(new VeoProvider());
    this.register(new HiggsfieldProvider());
  }

  register(provider: ProductionProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): ProductionProvider | undefined {
    return this.providers.get(id);
  }

  list(): ProductionProvider[] {
    return Array.from(this.providers.values());
  }

  rankProviders(spec: CreativeSpec, mode: CostMode = "ZERO_SPEND"): ProductionProvider[] {
    const available = Array.from(this.providers.values());
    if (mode === "ZERO_SPEND") {
      return available.filter((p) => p.capabilities.zeroSpend);
    }
    if (mode === "LOWEST_COST") {
      return [...available].sort(
        (a, b) => a.capabilities.costPerSecondEstimateUsd - b.capabilities.costPerSecondEstimateUsd,
      );
    }
    if (mode === "QUALITY_FIRST") {
      const preferred = ["veo", "higgsfield", "hypit", "manual_cloud"];
      return [...available].sort(
        (a, b) => preferred.indexOf(a.id) - preferred.indexOf(b.id),
      );
    }
    // BALANCED
    const preferred = ["hypit", "veo", "higgsfield", "manual_cloud"];
    return [...available].sort(
      (a, b) => preferred.indexOf(a.id) - preferred.indexOf(b.id),
    );
  }

  routeTheoretical(spec: CreativeSpec, mode: CostMode = "ZERO_SPEND"): ProductionProvider {
    const ranked = this.rankProviders(spec, mode);
    if (!ranked[0]) throw new Error(`No provider available for mode ${mode}.`);
    return ranked[0];
  }

  /**
   * Safe by default: routes only configured, operational providers.
   */
  async route(spec: CreativeSpec, mode: CostMode = "ZERO_SPEND"): Promise<ProductionProvider> {
    return this.routeConfigured(spec, mode);
  }

  async routeConfigured(spec: CreativeSpec, mode: CostMode = "ZERO_SPEND"): Promise<ProductionProvider> {
    const healthChecks = await Promise.all(
      Array.from(this.providers.values()).map(async (p) => ({
        provider: p,
        health: await p.health(),
      })),
    );

    const healthy = healthChecks
      .filter((h) => h.health.state === "HEALTHY")
      .map((h) => h.provider);

    const manualCloud = this.providers.get("manual_cloud");

    if (mode === "ZERO_SPEND") {
      const isManualCloudHealthy = healthy.some((p) => p.id === "manual_cloud");
      if (!isManualCloudHealthy) {
        throw new Error("ManualCloud provider is NOT_CONFIGURED (Google Drive not connected).");
      }
      return manualCloud!;
    }

    if (healthy.length === 0) {
      throw new Error(`No configured production providers available for mode ${mode}.`);
    }

    if (mode === "LOWEST_COST") {
      const sorted = [...healthy].sort(
        (a, b) => a.capabilities.costPerSecondEstimateUsd - b.capabilities.costPerSecondEstimateUsd,
      );
      return sorted[0]!;
    }

    if (mode === "QUALITY_FIRST") {
      const veo = healthy.find((p) => p.id === "veo");
      const hf = healthy.find((p) => p.id === "higgsfield");
      return veo || hf || healthy[0]!;
    }

    // BALANCED
    const hypit = healthy.find((p) => p.id === "hypit");
    const veo = healthy.find((p) => p.id === "veo");
    return hypit || veo || healthy[0]!;
  }
}

export const productionRouter = new ProductionRouter();
