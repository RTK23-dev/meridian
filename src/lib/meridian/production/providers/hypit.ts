import type { CreativeSpec, ProductionCapabilities, ProductionJob, ProductionProvider, ProviderHealth } from "../types.ts";

/**
 * The production `hypit` route is NOT CONNECTED. Its request body and status parsing were never the Hypit handoff contract
 * (src/lib/meridian/hypit/contract.ts and client.ts), so this route sends nothing and reads nothing until it is rewired to
 * that contract. The Hypit handoff in src/lib/meridian/hypit/handoff.ts is the only Hypit path.
 */
const NOT_CONNECTED_REASON =
  "NOT_CONNECTED: the production hypit route is not connected to the Hypit runtime. The Hypit handoff in src/lib/meridian/hypit/handoff.ts is the only Hypit path.";

/**
 * Nothing about Hypit is verified here: no per-second price, no latency. NaN is the unknown sentinel. The router's priceFor reads
 * a non-finite declaration as an unknown price, so the cost matrix never prices this route. Replace it only with a number that
 * has a cited source.
 */
const UNVERIFIED = Number.NaN;

/** A refusal before any request. Nothing was sent, so there is no estimate (NaN, not 0) and no bill. */
function notConnectedJob(spec: CreativeSpec, providerId: string): ProductionJob {
  const now = new Date().toISOString();
  return {
    jobId: "",
    organizationId: spec.organizationId,
    brandId: spec.brandId,
    creativeSpec: spec,
    providerId,
    status: "NOT_CONFIGURED",
    errorCode: "NOT_CONNECTED",
    costEstimateUsd: UNVERIFIED,
    error: `${NOT_CONNECTED_REASON} No job was sent.`,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The production Hypit route, refused until it is connected. It makes no request, reads no key, returns no receipt, and claims
 * no capability it cannot provide. The constructor options are accepted so existing construction sites still compile; they are
 * not used.
 */
export class HypitProvider implements ProductionProvider {
  readonly id = "hypit";
  readonly capabilities: ProductionCapabilities = {
    textToVideo: false,
    imageToVideo: false,
    timelineEditing: false,
    voiceoverGeneration: false,
    zeroSpend: false,
    averageLatencySeconds: UNVERIFIED,
    costPerSecondEstimateUsd: UNVERIFIED,
  };

  constructor(_options?: { fetchImpl?: typeof fetch; apiKey?: string }) {}

  healthFor(organizationId: string): Promise<ProviderHealth> {
    return this.health(organizationId);
  }

  /** NOT_CONFIGURED is the only state the router refuses for an explicit choice and never selects automatically. */
  async health(_organizationId?: string): Promise<ProviderHealth> {
    return {
      id: this.id,
      state: "NOT_CONFIGURED",
      capabilities: [],
      detail: NOT_CONNECTED_REASON,
      checkedAt: new Date().toISOString(),
    };
  }

  async submitJob(spec: CreativeSpec): Promise<ProductionJob> {
    return notConnectedJob(spec, this.id);
  }

  async checkJobStatus(_jobId: string, _metadata?: Record<string, unknown>): Promise<ProductionJob> {
    throw new Error(`Cannot check Hypit job status: ${NOT_CONNECTED_REASON}`);
  }

  async cancelJob(_jobId: string, _metadata?: Record<string, unknown>): Promise<void> {
    throw new Error(`Cannot cancel Hypit job: ${NOT_CONNECTED_REASON}`);
  }
}
