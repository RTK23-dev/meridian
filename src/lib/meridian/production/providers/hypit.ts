import { secretForCategory } from "../../credentials/resolve.ts";
import type {
  CreativeSpec,
  ProductionCapabilities,
  ProductionJob,
  ProductionProvider,
  ProviderHealth,
} from "../types.ts";

export class HypitProvider implements ProductionProvider {
  readonly id = "hypit";
  readonly capabilities: ProductionCapabilities = {
    textToVideo: false,
    imageToVideo: false,
    timelineEditing: true,
    voiceoverGeneration: true,
    zeroSpend: false,
    averageLatencySeconds: 120,
    costPerSecondEstimateUsd: 0.05,
  };

  private fetchImpl: typeof fetch;
  private readonly apiKey?: string;

  /**
   * `apiKey` is the workspace's key when the caller already holds it (explicit wiring and tests). Without it, each request
   * resolves the workspace's key through the credential resolver.
   */
  constructor(options?: { fetchImpl?: typeof fetch; apiKey?: string }) {
    this.fetchImpl = options?.fetchImpl || globalThis.fetch;
    this.apiKey = options?.apiKey;
  }

  private getBaseUrl(): string | undefined {
    return process.env.HYPIT_BASE_URL?.trim();
  }

  /** The workspace's Hypit key, through the credential resolver. With no workspace in scope there is no key. */
  private async tokenFor(organizationId: string | undefined): Promise<{ token: string | null; reason: string }> {
    if (this.apiKey) return { token: this.apiKey, reason: "" };
    const resolved = await secretForCategory("hypit", organizationId);
    return { token: resolved.secret, reason: resolved.reason };
  }

  healthFor(organizationId: string): Promise<ProviderHealth> {
    return this.health(organizationId);
  }

  async health(organizationId?: string): Promise<ProviderHealth> {
    const baseUrl = this.getBaseUrl();
    if (!baseUrl) {
      return {
        id: this.id,
        state: "NOT_CONFIGURED",
        capabilities: [],
        detail: "HYPIT_BASE_URL is not set.",
        checkedAt: new Date().toISOString(),
      };
    }

    const { token } = await this.tokenFor(organizationId);
    try {
      const res = await this.fetchImpl(`${baseUrl.replace(/\/+$/, "")}/health`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        return {
          id: this.id,
          state: "HEALTHY",
          capabilities: ["timelineEditing", "voiceoverGeneration"],
          detail: `Hypit runtime reachable at ${baseUrl}.`,
          checkedAt: new Date().toISOString(),
        };
      }
      return {
        id: this.id,
        state: "DEGRADED",
        capabilities: [],
        detail: `Hypit runtime returned status ${res.status}.`,
        checkedAt: new Date().toISOString(),
      };
    } catch {
      return {
        id: this.id,
        state: "UNAVAILABLE",
        capabilities: [],
        detail: `Hypit runtime unreachable at ${baseUrl}.`,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  async submitJob(spec: CreativeSpec): Promise<ProductionJob> {
    const baseUrl = this.getBaseUrl();
    const costEstimate = spec.durationTargetSeconds * this.capabilities.costPerSecondEstimateUsd;

    if (!baseUrl) {
      return {
        jobId: "",
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        creativeSpec: spec,
        providerId: this.id,
        status: "NOT_CONFIGURED",
        costEstimateUsd: costEstimate,
        error: "Hypit runtime is not configured (HYPIT_BASE_URL unset).",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    const { token, reason } = await this.tokenFor(spec.organizationId);
    if (!token) {
      return {
        jobId: "",
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        creativeSpec: spec,
        providerId: this.id,
        status: "NOT_CONFIGURED",
        costEstimateUsd: costEstimate,
        error: `${reason} No job was sent.`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    try {
      const res = await this.fetchImpl(`${baseUrl.replace(/\/+$/, "")}/v1/jobs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(spec.idempotencyKey ? { "idempotency-key": spec.idempotencyKey } : {}),
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          meridianJobId: spec.idempotencyKey ? `prod_hypit_${spec.idempotencyKey}` : `prod_hypit_${globalThis.crypto.randomUUID()}`,
          creativeSpec: spec,
          targetDurationSeconds: spec.durationTargetSeconds,
          aspectRatio: spec.aspectRatio,
        }),
      });

      if (!res.ok) {
        return {
          jobId: "",
          organizationId: spec.organizationId,
          brandId: spec.brandId,
          creativeSpec: spec,
          providerId: this.id,
          status: res.status >= 500 ? "SUBMISSION_UNKNOWN" : "FAILED",
          costEstimateUsd: costEstimate,
          error: `Hypit rejected job submission (${res.status}): ${await res.text()}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }

      const data = (await res.json()) as { id?: string; jobId?: string; status?: string };
      const externalId = data.id || data.jobId;
      if (!externalId) {
        return {
          jobId: "",
          organizationId: spec.organizationId,
          brandId: spec.brandId,
          creativeSpec: spec,
          providerId: this.id,
          status: "SUBMISSION_UNKNOWN",
          costEstimateUsd: costEstimate,
          error: "Hypit response missing job ID.",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }

      return {
        jobId: externalId,
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        creativeSpec: spec,
        providerId: this.id,
        status: data.status === "completed" || data.status === "succeeded" ? "RENDERED" : "RUNNING",
        costEstimateUsd: costEstimate,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        jobId: "",
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        creativeSpec: spec,
        providerId: this.id,
        status: "SUBMISSION_UNKNOWN",
        costEstimateUsd: costEstimate,
        error: `Failed to connect to Hypit process: ${err instanceof Error ? err.message : String(err)}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
  }

  async checkJobStatus(jobId: string, metadata?: Record<string, unknown>): Promise<ProductionJob> {
    const baseUrl = this.getBaseUrl();
    if (!baseUrl) {
      throw new Error("Cannot check Hypit job status: HYPIT_BASE_URL is not configured.");
    }
    const { token, reason } = await this.tokenFor(typeof metadata?.organizationId === "string" ? metadata.organizationId : undefined);
    if (!token) throw new Error(`Cannot check Hypit job status: ${reason}`);

    const res = await this.fetchImpl(`${baseUrl.replace(/\/+$/, "")}/v1/jobs/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      throw new Error(`Hypit status poll failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as {
      id?: string;
      status?: string;
      error?: string;
      outputArtifactId?: string;
    };

    let status: ProductionJob["status"] = "RUNNING";
    if (data.status === "succeeded" || data.status === "completed") status = "RENDERED";
    else if (data.status === "failed") status = "FAILED";
    else if (data.status === "queued") status = "QUEUED";

    return {
      jobId,
      organizationId: "",
      brandId: "",
      creativeSpec: {} as CreativeSpec,
      providerId: this.id,
      status,
      costEstimateUsd: 0,
      outputArtifactId: data.outputArtifactId,
      error: data.error,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async cancelJob(jobId: string, metadata?: Record<string, unknown>): Promise<void> {
    const baseUrl = this.getBaseUrl();
    if (!baseUrl) return;
    const { token } = await this.tokenFor(typeof metadata?.organizationId === "string" ? metadata.organizationId : undefined);
    if (!token) return;
    try {
      await this.fetchImpl(`${baseUrl.replace(/\/+$/, "")}/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // Best-effort cancellation
    }
  }
}
