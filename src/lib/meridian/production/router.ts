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
import { GeminiOmniVideoProvider } from "./providers/omni.ts";
import { HiggsfieldProvider } from "./providers/higgsfield.ts";
import { modelCapabilityRegistry } from "./registry.ts";
import { selectOffer, type SelectionCandidate, type SelectionModality, type SelectionRecord, type SelectionRequirement } from "./capability-matrix.ts";
import { configuredQuote, estimateCost, unknownQuote, type PriceQuote } from "./pricing.ts";
import { GoogleNanoBananaImageProvider, TestImageProvider, type ProductionImageProvider } from "./image-providers.ts";
import { isTestingRuntimeNow as testingRuntimeNow } from "../runtime-mode.ts";
import type { ProviderHealth } from "./types.ts";

/**
 * A provider's readiness for one workspace. A provider whose key is saved per workspace implements `healthFor`, and that
 * check is used whenever the workspace is known. Every other provider uses `health`.
 */
async function healthOf(
  provider: { health(): Promise<ProviderHealth> },
  organizationId: string | undefined,
): Promise<ProviderHealth> {
  const scoped = provider as { health(): Promise<ProviderHealth>; healthFor?: (organizationId: string) => Promise<ProviderHealth> };
  return organizationId && scoped.healthFor ? scoped.healthFor(organizationId) : provider.health();
}

/** Automatic preference order by cost mode. The matrix decides eligibility first; this only orders eligible providers. */
const PREFERENCE_BY_MODE: Record<"BALANCED" | "QUALITY_FIRST", string[]> = {
  BALANCED: ["google_omni", "hypit", "higgsfield", "manual_cloud", "veo"],
  QUALITY_FIRST: ["google_omni", "higgsfield", "hypit", "manual_cloud", "veo"],
};

export interface ProviderSelection {
  provider: ProductionProvider;
  selection: SelectionRecord;
}

export interface ImageProviderSelection {
  provider: ProductionImageProvider;
  selection: SelectionRecord;
}

/** Automatic image preference. The matrix decides eligibility first; this only orders eligible providers. */
const IMAGE_PREFERENCE = ["google_nano_banana", "test:image"];

/** Any provider the matrix can price: a video provider or an image provider. */
type CandidateProvider = PricedProvider & { capabilities: PricedProvider["capabilities"] & { zeroSpend: boolean } };

/**
 * The requirement a spec places on a provider. Only video is routed so far: an image or carousel needs its own
 * durable path (P4b-2), so it is refused here rather than sent to a video model.
 */
export function requirementFor(spec: CreativeSpec): SelectionRequirement {
  if (spec.modality !== "video") {
    throw new Error(`production modality '${spec.modality}' is not routed yet; only video is selected by the capability matrix`);
  }
  return {
    modality: "video",
    task: spec.sourceMediaUrl ? "image-to-video" : "text-to-video",
    durationSeconds: spec.durationTargetSeconds,
    aspectRatio: spec.aspectRatio,
    units: spec.durationTargetSeconds,
  };
}

/**
 * The price Meridian holds for a provider. A video price is the owner's per-second declaration in provider configuration.
 * No image price is declared for any provider, so an image price is unknown, not zero.
 */
/** The provider fields a price is read from. A video provider declares per-second, an image provider per-image. */
export interface PricedProvider {
  id: string;
  capabilities: { costPerSecondEstimateUsd?: number; costPerImageEstimateUsd?: number };
}

export function priceFor(provider: PricedProvider, modality: SelectionModality): PriceQuote {
  if (modality === "video") {
    const declared = provider.capabilities.costPerSecondEstimateUsd;
    if (typeof declared !== "number" || !Number.isFinite(declared)) {
      return unknownQuote("per_second", `provider ${provider.id} declares no per-second price`);
    }
    return configuredQuote("per_second", declared, `code-declared estimate in the ${provider.id} adapter; not checked against the provider price page`);
  }
  const declared = provider.capabilities.costPerImageEstimateUsd;
  if (typeof declared !== "number" || !Number.isFinite(declared)) {
    return unknownQuote("per_image", `no image price is declared for ${provider.id}`);
  }
  return configuredQuote("per_image", declared, `code-declared estimate in the ${provider.id} adapter; not checked against the provider price page`);
}

/**
 * The requirement an image places on a provider. An image has no duration and bills one image. Image-to-image is not
 * routed yet, so a spec with source media is refused rather than generated from text alone.
 */
export function requirementForImage(spec: CreativeSpec): SelectionRequirement {
  if (spec.modality !== "image") throw new Error(`requirementForImage needs an image spec, got '${spec.modality}'`);
  if (spec.sourceMediaUrl) throw new Error("image-to-image is not routed yet; an image spec with source media is refused");
  return { modality: "image", task: "text-to-image", durationSeconds: null, aspectRatio: spec.aspectRatio, units: 1 };
}

export class ProductionRouter {
  private providers = new Map<string, ProductionProvider>();
  private imageProviders = new Map<string, ProductionImageProvider>();
  readonly runtime: "production" | "testing";

  constructor(options?: { runtime?: "production" | "testing"; providers?: ProductionProvider[]; imageProviders?: ProductionImageProvider[] }) {
    this.runtime =
      options?.runtime ||
      (process.env.NODE_ENV === "test" || process.env.MERIDIAN_TESTING_RUNTIME === "true"
        ? "testing"
        : "production");

    if (options?.providers) {
      for (const p of options.providers) {
        this.register(p);
      }
    } else {
      this.register(new ManualCloudProvider());
      this.register(new HypitProvider());
      this.register(new GeminiOmniVideoProvider());
      this.register(new VeoProvider());
      this.register(new HiggsfieldProvider());
    }

    if (options?.imageProviders) {
      for (const p of options.imageProviders) this.registerImage(p);
    } else {
      this.registerImage(new GoogleNanoBananaImageProvider());
      // The test double is always listed, but it is resolved and selected only while the testing runtime is active.
      const testImage = new TestImageProvider();
      this.imageProviders.set(testImage.id, testImage);
    }
  }

  registerImage(provider: ProductionImageProvider): void {
    if (this.runtime === "production" && provider.id === "test:image") {
      throw new Error(`Cannot register test provider '${provider.id}' in ProductionRuntime.`);
    }
    this.imageProviders.set(provider.id, provider);
  }

  getImage(id: string): ProductionImageProvider | undefined {
    if (id === "test:image" && !testingRuntimeNow()) return undefined;
    return this.imageProviders.get(id);
  }

  register(provider: ProductionProvider): void {
    if (this.runtime === "production" && (provider.id === "test:video" || provider.id === "test")) {
      throw new Error(`Cannot register test provider '${provider.id}' in ProductionRuntime.`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): ProductionProvider | undefined {
    if (this.runtime === "production" && (id === "test:video" || id === "test")) {
      return undefined;
    }
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
      // Ranks on the price quote, not the raw declaration. A known amount sorts first, cheapest first. An unknown price
      // sorts last, and is never treated as zero.
      const modality: SelectionModality = (spec as { modality?: string }).modality === "image" ? "image" : "video";
      const amountOf = (provider: ProductionProvider): number | null => {
        const quote = priceFor(provider, modality);
        return quote.status !== "unknown" && typeof quote.amountUsd === "number" ? quote.amountUsd : null;
      };
      return [...available].sort((a, b) => {
        const left = amountOf(a);
        const right = amountOf(b);
        if (left === null && right === null) return 0;
        if (left === null) return 1;
        if (right === null) return -1;
        return left - right;
      });
    }
    if (mode === "QUALITY_FIRST") {
      // Veo preview is excluded from automatic priority; Omni is primary Google video
      const preferred = ["google_omni", "higgsfield", "hypit", "manual_cloud", "veo"];
      return [...available].sort(
        (a, b) => preferred.indexOf(a.id) - preferred.indexOf(b.id),
      );
    }
    // BALANCED
    const preferred = ["google_omni", "hypit", "higgsfield", "manual_cloud", "veo"];
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
   * Explicit provider routing: verifies requested provider without silent fallback.
   */
  async routeExplicit(id: string, spec: CreativeSpec): Promise<ProductionProvider> {
    const provider = this.get(id);
    if (!provider) {
      throw new Error(
        `Production provider '${id}' is not registered or cannot be resolved in ${this.runtime} runtime.`,
      );
    }
    const health = await healthOf(provider, spec.organizationId);
    if (health.state === "NOT_CONFIGURED") {
      throw new Error(`Provider '${id}' is NOT_CONFIGURED: ${health.detail || "Credentials missing."}`);
    }
    if (health.state === "UNAVAILABLE" || health.state === "AUTH_FAILED") {
      throw new Error(`Provider '${id}' is ${health.state}: ${health.detail || "Provider offline."}`);
    }
    return provider;
  }

  /**
   * Safe by default: routes only configured, operational providers.
   * If requestedProvider is specified and not 'auto', respects the selection strictly.
   */
  async route(
    spec: CreativeSpec,
    mode: CostMode = "ZERO_SPEND",
    requestedProvider?: string,
  ): Promise<ProductionProvider> {
    return (await this.selectForSpec(spec, mode, requestedProvider)).provider;
  }

  async selectForSpec(spec: CreativeSpec, mode: CostMode = "ZERO_SPEND", requestedProvider?: string): Promise<ProviderSelection> {
    const requirement = requirementFor(spec);
    if (requestedProvider && requestedProvider !== "auto") {
      const provider = await this.routeExplicit(requestedProvider, spec);
      // An explicit provider is a deliberate choice: deprecated, zero-spend and unpriced candidates are allowed, and recorded.
      const selection = selectOffer({
        candidates: this.candidatesFor([provider], requirement.modality),
        requirement,
        registry: modelCapabilityRegistry,
        mode: "PREFERENCE",
        preference: [requestedProvider],
        allowDeprecated: true,
        allowZeroSpend: true,
        allowUnknownCost: true,
      });
      if (!selection.chosen) {
        throw new Error(`Provider '${requestedProvider}' cannot produce this deliverable: ${summarize(selection)}`);
      }
      return { provider, selection };
    }

    const healthy = await this.healthyProviders(spec.organizationId);
    if (mode === "ZERO_SPEND") {
      const manualCloud = healthy.find((p) => p.id === "manual_cloud");
      if (!manualCloud) throw new Error("ManualCloud provider is NOT_CONFIGURED (Google Drive not connected).");
      const cost = estimateCost(priceFor(manualCloud, requirement.modality), requirement.units, "per_second");
      return {
        provider: manualCloud,
        selection: {
          requirement,
          mode: "PREFERENCE",
          chosen: {
            providerId: manualCloud.id,
            modelId: modelCapabilityRegistry.listModels(manualCloud.id)[0]?.model_id ?? "",
            costKnown: cost.costKnown,
            costStatus: cost.costStatus,
            estimateUsd: cost.estimateUsd,
          },
          rejected: [],
        },
      };
    }
    if (healthy.length === 0) throw new Error(`No configured production providers available for mode ${mode}.`);

    // Automatic selection never sends work to an unknown or stale price (allowUnknownCost is not set).
    const selection = selectOffer({
      candidates: this.candidatesFor(healthy, requirement.modality),
      requirement,
      registry: modelCapabilityRegistry,
      mode: mode === "LOWEST_COST" ? "LOWEST_COST" : "PREFERENCE",
      preference: mode === "LOWEST_COST" ? undefined : PREFERENCE_BY_MODE[mode],
    });
    if (!selection.chosen) throw new Error(`No eligible production provider for mode ${mode}: ${summarize(selection)}`);
    const provider = healthy.find((p) => p.id === selection.chosen!.providerId);
    if (!provider) throw new Error(`Chosen provider '${selection.chosen.providerId}' is no longer healthy.`);
    return { provider, selection };
  }

  /**
   * Chooses the image provider and model for an image spec with the same matrix as video. Automatic selection refuses an
   * unknown price unless the caller allows it. The executor allows it only for a deliverable reserved against an explicit
   * spend cap (see planReservationShares), so the spend stays bounded. An explicit provider is a deliberate choice.
   */
  async selectImageForSpec(
    spec: CreativeSpec,
    options: { requestedProvider?: string; allowUnknownCost: boolean },
  ): Promise<ImageProviderSelection> {
    const requirement = requirementForImage(spec);
    const requested = options.requestedProvider && options.requestedProvider !== "auto" ? options.requestedProvider : null;
    if (requested) {
      const provider = this.getImage(requested);
      if (!provider) {
        if (requested === "test:image") throw new Error("The test image provider is not enabled outside the testing runtime.");
        throw new Error(`Image provider '${requested}' is not registered or cannot be resolved in ${this.runtime} runtime.`);
      }
      const health = await healthOf(provider, spec.organizationId);
      if (health.state === "NOT_CONFIGURED") throw new Error(`Provider '${requested}' is NOT_CONFIGURED: ${health.detail || "Credentials missing."}`);
      if (health.state === "UNAVAILABLE" || health.state === "AUTH_FAILED") throw new Error(`Provider '${requested}' is ${health.state}: ${health.detail || "Provider offline."}`);
      const selection = selectOffer({
        candidates: this.candidatesFor([provider], "image"),
        requirement,
        registry: modelCapabilityRegistry,
        mode: "PREFERENCE",
        preference: [requested],
        allowDeprecated: true,
        allowZeroSpend: true,
        allowUnknownCost: true,
      });
      if (!selection.chosen) throw new Error(`Provider '${requested}' cannot produce this deliverable: ${summarize(selection)}`);
      return { provider, selection };
    }

    const healthy = await this.healthyImageProviders(spec.organizationId);
    if (healthy.length === 0) throw new Error("No configured image provider is available.");
    const selection = selectOffer({
      candidates: this.candidatesFor(healthy, "image"),
      requirement,
      registry: modelCapabilityRegistry,
      mode: "PREFERENCE",
      preference: IMAGE_PREFERENCE,
      allowUnknownCost: options.allowUnknownCost,
    });
    if (!selection.chosen) throw new Error(`No eligible image provider: ${summarize(selection)}`);
    const provider = healthy.find((p) => p.id === selection.chosen!.providerId);
    if (!provider) throw new Error(`Chosen image provider '${selection.chosen.providerId}' is no longer healthy.`);
    return { provider, selection };
  }

  /** Image providers that are ready for this workspace. Without a workspace, a workspace-keyed provider is not ready. */
  private async healthyImageProviders(organizationId?: string): Promise<ProductionImageProvider[]> {
    const usable = Array.from(this.imageProviders.values()).filter((p) => p.id !== "test:image" || testingRuntimeNow());
    const checks = await Promise.all(usable.map(async (p) => ({ provider: p, health: await healthOf(p, organizationId) })));
    return checks.filter((c) => c.health.state === "HEALTHY" || c.health.state === "CONFIGURED").map((c) => c.provider);
  }

  private async healthyProviders(organizationId?: string): Promise<ProductionProvider[]> {
    const checks = await Promise.all(
      Array.from(this.providers.values()).map(async (p) => ({ provider: p, health: await healthOf(p, organizationId) })),
    );
    return checks.filter((c) => c.health.state === "HEALTHY" || c.health.state === "CONFIGURED").map((c) => c.provider);
  }

  /** Every registered model of these providers, as selection candidates, priced for this modality. */
  private candidatesFor(providers: CandidateProvider[], modality: SelectionModality): SelectionCandidate[] {
    return providers.flatMap((provider) =>
      modelCapabilityRegistry.listModels(provider.id).map((record) => ({
        provider: {
          id: provider.id,
          zeroSpend: provider.capabilities.zeroSpend,
          price: priceFor(provider, modality),
        },
        record,
      })),
    );
  }
}

function summarize(selection: SelectionRecord): string {
  if (selection.rejected.length === 0) return "no candidate offers this model.";
  return selection.rejected.map((item) => `${item.providerId}/${item.modelId}: ${item.reasons.join(", ")}`).join("; ");
}

export const productionRouter = new ProductionRouter();
