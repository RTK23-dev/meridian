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

  route(spec: CreativeSpec, mode: CostMode = "ZERO_SPEND"): ProductionProvider {
    const manualCloud = this.providers.get("manual_cloud");

    if (mode === "ZERO_SPEND") {
      if (!manualCloud) throw new Error("ManualCloud zero-spend provider is not registered.");
      return manualCloud;
    }

    const available = Array.from(this.providers.values());

    if (mode === "LOWEST_COST") {
      // Sort ascending by cost per second
      const sorted = [...available].sort(
        (a, b) => a.capabilities.costPerSecondEstimateUsd - b.capabilities.costPerSecondEstimateUsd,
      );
      return sorted[0] || manualCloud!;
    }

    if (mode === "QUALITY_FIRST") {
      // Prefer generative models if spec requires AI scene generation
      const veo = this.providers.get("veo");
      const hf = this.providers.get("higgsfield");
      return veo || hf || manualCloud!;
    }

    // BALANCED: Hypit or generative if budget permits
    const hypit = this.providers.get("hypit");
    return hypit || manualCloud!;
  }
}

export const productionRouter = new ProductionRouter();
