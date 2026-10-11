/**
 * Higgsfield Provider
 *
 * Async video generation via Higgsfield AI platform:
 * - Uses Bearer-less Key auth header (Authorization: Key <api_key>)
 * - Posts to requests endpoint and retains request_id, status_url, and cancel_url as records
 * - Polls and cancels /v1/requests/<request_id>/{status,cancel} on HIGGSFIELD_ORIGIN only. The key is never sent to a URL
 *   the provider returned or a stored URL names, so a returned status_url or cancel_url cannot redirect the key elsewhere.
 * - Redirects on authenticated calls are refused, not followed
 * - Never invents job IDs
 */

import type {
  CreativeSpec,
  ProductionCapabilities,
  ProductionJob,
  ProductionProvider,
  ProviderHealth,
} from "../types.ts";
import type { Sql } from "../../learning/store.ts";
import { loadDefaultSql, resolveHiggsfieldCredential, type CredentialEnv } from "../../credentials/resolve.ts";
import type { CredentialResolution } from "../../credentials/contract.ts";

/** A workspace's usable key, or the reason there is none. The provider is never called without a usable key. */
type KeyAccess = { ok: true; apiKey: string } | { ok: false; reason: string };

/** The one origin the workspace key is ever sent to. */
export const HIGGSFIELD_ORIGIN = "https://api.higgsfield.ai";

/** A status check or cancel that gets no answer in this long is abandoned. */
const CONTROL_REQUEST_TIMEOUT_MS = 30_000;

/** Opaque request ids: letters, digits, underscore and hyphen. A URL, a path or a dot segment is refused before any request. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type HiggsfieldRequestErrorCode = "INVALID_JOB_ID" | "MALFORMED_RESPONSE" | "REDIRECT_REFUSED";

/**
 * A failed call to Higgsfield. `status` is the HTTP status when a response arrived. `code` names a contract failure that
 * has no useful status. The poller classifies on these fields, never on the message. A failure with neither (a network
 * error or a timeout) has no status.
 */
export class HiggsfieldRequestError extends Error {
  readonly status?: number;
  readonly code?: HiggsfieldRequestErrorCode;

  constructor(message: string, options: { status?: number; code?: HiggsfieldRequestErrorCode } = {}) {
    super(message);
    this.name = "HiggsfieldRequestError";
    this.status = options.status;
    this.code = options.code;
  }
}

/**
 * The authenticated URL for one request, built from its opaque id and HIGGSFIELD_ORIGIN. Nothing the provider returned is
 * used here, so the key can only ever be sent to HIGGSFIELD_ORIGIN.
 */
export function higgsfieldRequestUrl(requestId: string, action: "status" | "cancel"): string {
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new HiggsfieldRequestError("The Higgsfield request id is not a valid opaque id. No request was sent.", { code: "INVALID_JOB_ID" });
  }
  return `${HIGGSFIELD_ORIGIN}/v1/requests/${requestId}/${action}`;
}

export type HiggsfieldModelDefinition = {
  path: string;
  supportedAspectRatios: string[];
  buildPayload: (spec: CreativeSpec) => Record<string, unknown>;
};

export const HIGGSFIELD_MODELS: Record<string, HiggsfieldModelDefinition> = {
  "higgsfield-video-v1": {
    path: "/higgsfield/video/v1.0",
    supportedAspectRatios: ["9:16", "16:9", "1:1"],
    buildPayload: (spec: CreativeSpec) => ({
      prompt: spec.hookLine ? `${spec.hookLine}\n${spec.script}` : spec.script,
      duration: spec.durationTargetSeconds,
      aspect_ratio: spec.aspectRatio,
    }),
  },
  "dop-v1": {
    path: "/higgsfield/dop/v1.0",
    supportedAspectRatios: ["9:16", "16:9"],
    buildPayload: (spec: CreativeSpec) => ({
      prompt: spec.hookLine ? `${spec.hookLine}\n${spec.script}` : spec.script,
      duration: spec.durationTargetSeconds,
      aspect_ratio: spec.aspectRatio,
      camera_motion: "pan_zoom_auto",
    }),
  },
  "genjutsu-v1": {
    path: "/higgsfield/genjutsu/restyle/v1.0",
    supportedAspectRatios: ["9:16", "16:9"],
    buildPayload: (spec: CreativeSpec) => ({
      prompt: spec.hookLine ? `${spec.hookLine}\n${spec.script}` : spec.script,
      duration: spec.durationTargetSeconds,
      aspect_ratio: spec.aspectRatio,
    }),
  },
  "seedance-v1": {
    path: "/seedance/v1.0",
    supportedAspectRatios: ["9:16", "16:9"],
    buildPayload: (spec: CreativeSpec) => ({
      prompt: spec.hookLine ? `${spec.hookLine}\n${spec.script}` : spec.script,
      duration: spec.durationTargetSeconds,
      aspect_ratio: spec.aspectRatio,
    }),
  },
};

export const HiggsfieldModelRegistry = HIGGSFIELD_MODELS;

export type HiggsfieldModel = keyof typeof HIGGSFIELD_MODELS;

export class HiggsfieldProvider implements ProductionProvider {
  readonly id = "higgsfield";
  readonly capabilities: ProductionCapabilities = {
    textToVideo: true,
    imageToVideo: true,
    timelineEditing: false,
    voiceoverGeneration: false,
    zeroSpend: false,
    averageLatencySeconds: 60,
    costPerSecondEstimateUsd: 0.15,
  };

  private fetchImpl: typeof fetch;
  private readonly sql?: Sql;
  private readonly env?: CredentialEnv;
  private readonly lookup?: (organizationId: string) => Promise<CredentialResolution>;

  /**
   * No key is held here. The deployment key is used for a workspace only when PRODUCTION_SHARED_DEFAULT=deployment is set, and
   * never in place of that workspace's unusable saved production entry.
   */
  constructor(options?: {
    fetchImpl?: typeof fetch;
    sql?: Sql;
    env?: CredentialEnv;
    lookup?: (organizationId: string) => Promise<CredentialResolution>;
  }) {
    this.fetchImpl = options?.fetchImpl || globalThis.fetch;
    this.sql = options?.sql;
    this.env = options?.env;
    this.lookup = options?.lookup;
  }

  /** The key for this workspace, by the shared resolver. Nothing is cached between calls. */
  private async credentialFor(organizationId: string): Promise<CredentialResolution> {
    if (this.lookup) return this.lookup(organizationId);
    const sql = this.sql ?? (await loadDefaultSql());
    return resolveHiggsfieldCredential(sql, organizationId, this.env ?? process.env);
  }

  /** The usable key for this workspace, or the reason there is none. A failed read is "no call", never a fallback. */
  private async keyFor(organizationId: string | undefined): Promise<KeyAccess> {
    if (!organizationId) {
      return { ok: false, reason: "Higgsfield needs a workspace production credential, and no workspace was given. No request was sent." };
    }
    try {
      const resolution = await this.credentialFor(organizationId);
      if (resolution.status === "ready") return { ok: true, apiKey: resolution.secret };
      return { ok: false, reason: resolution.reason };
    } catch {
      return { ok: false, reason: "The workspace's production credential for Higgsfield could not be read. No request was sent." };
    }
  }

  getModel(): HiggsfieldModel {
    const configured = process.env.HIGGSFIELD_MODEL?.trim();
    if (configured && configured in HIGGSFIELD_MODELS) {
      return configured as HiggsfieldModel;
    }
    return "higgsfield-video-v1";
  }

  /** Without a workspace there is no check to make, so this never reports CONFIGURED. */
  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      state: "NOT_CONFIGURED",
      capabilities: [],
      detail: "Higgsfield's key is the deployment's, used only when PRODUCTION_SHARED_DEFAULT=deployment is set. Readiness is checked for a workspace, and none was given.",
      checkedAt: new Date().toISOString(),
    };
  }

  /** Readiness for one workspace. An unusable saved production entry is never reported as ready for Higgsfield. */
  async healthFor(organizationId: string): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    const access = await this.keyFor(organizationId);
    if (!access.ok) {
      return { id: this.id, state: "NOT_CONFIGURED", capabilities: [], detail: access.reason, checkedAt };
    }
    return {
      id: this.id,
      state: "CONFIGURED",
      capabilities: ["textToVideo", "imageToVideo"],
      detail: `Higgsfield configured with model ${this.getModel()}, using the deployment shared default key.`,
      checkedAt,
    };
  }

  async submitJob(spec: CreativeSpec): Promise<ProductionJob> {
    const access = await this.keyFor(spec.organizationId);
    const costEstimate = spec.durationTargetSeconds * this.capabilities.costPerSecondEstimateUsd;

    if (!access.ok) {
      return {
        jobId: "",
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        creativeSpec: spec,
        providerId: this.id,
        status: "NOT_CONFIGURED",
        costEstimateUsd: costEstimate,
        error: access.reason,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    const model = this.getModel();
    if (spec.modelId && spec.modelId !== model) {
      return {
        jobId: "",
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        creativeSpec: spec,
        providerId: this.id,
        status: "FAILED",
        costEstimateUsd: costEstimate,
        error: `CreativePlan model '${spec.modelId}' does not match configured provider model '${model}'.`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    const modelDef = HIGGSFIELD_MODELS[model] || HIGGSFIELD_MODELS["higgsfield-video-v1"];
    const endpoint = `${HIGGSFIELD_ORIGIN}${modelDef.path}`;
    const payload = modelDef.buildPayload(spec);

    try {
      const res = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Key ${access.apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorText = await res.text();
        const errorCode = res.status === 401 || res.status === 403
          ? "AUTH_FAILED"
          : res.status === 429
            ? "RATE_LIMITED"
            : "UPSTREAM_5XX";

        return {
          jobId: "",
          organizationId: spec.organizationId,
          brandId: spec.brandId,
          creativeSpec: spec,
          providerId: this.id,
          status: res.status >= 500 ? "SUBMISSION_UNKNOWN" : "FAILED",
          costEstimateUsd: costEstimate,
          errorCode,
          error: `Higgsfield rejected submission (${res.status}) [${errorCode}]: ${errorText}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }

      let data: any;
      try {
        data = await res.json();
      } catch {
        return {
          jobId: "",
          organizationId: spec.organizationId,
          brandId: spec.brandId,
          creativeSpec: spec,
          providerId: this.id,
          status: "SUBMISSION_UNKNOWN",
          costEstimateUsd: costEstimate,
          errorCode: "MALFORMED_RESPONSE",
          error: "Higgsfield returned malformed JSON response.",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }

      const requestId = data.request_id || data.id || data.job_id;
      const statusUrl = data.status_url;
      const cancelUrl = data.cancel_url;

      // A request id that is not opaque cannot be polled safely, so it is not tracked. The submission may have been accepted.
      if (!requestId || !statusUrl || !REQUEST_ID_PATTERN.test(String(requestId))) {
        return {
          jobId: "",
          organizationId: spec.organizationId,
          brandId: spec.brandId,
          creativeSpec: spec,
          providerId: this.id,
          status: "SUBMISSION_UNKNOWN",
          costEstimateUsd: costEstimate,
          errorCode: "MALFORMED_RESPONSE",
          error: "Higgsfield response is missing request_id or status_url, or its request_id is not an opaque id this workspace can poll.",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }

      const status = data.status === "completed"
        ? "RENDERED"
        : data.status === "queued"
          ? "QUEUED"
          : "RUNNING";

      return {
        jobId: requestId,
        providerJobId: requestId,
        requestId,
        statusUrl,
        cancelUrl,
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        creativeSpec: spec,
        providerId: this.id,
        status,
        costEstimateUsd: costEstimate,
        submittedAt: new Date().toISOString(),
        metadata: {
          // The workspace that owns the job. A later poll or cancel resolves that workspace's key, and no other.
          organizationId: spec.organizationId,
          requestId,
          statusUrl,
          cancelUrl,
          model,
        },
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
        error: `Failed to contact Higgsfield API: ${err instanceof Error ? err.message : String(err)}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * The poll uses the key of the workspace that owns the job, which the job's metadata names. The URL comes from the request id
   * alone, so a stored or returned URL never receives the key. Without a usable key it throws, so no request is sent. A failed
   * check throws a HiggsfieldRequestError that carries its HTTP status for the poller to classify.
   */
  async checkJobStatus(jobId: string, metadata?: Record<string, unknown>): Promise<ProductionJob> {
    const pollUrl = higgsfieldRequestUrl(jobId, "status");
    const owner = typeof metadata?.organizationId === "string" ? metadata.organizationId : undefined;
    const access = await this.keyFor(owner);
    if (!access.ok) {
      throw new Error(`Cannot check Higgsfield job status: ${access.reason}`);
    }

    const res = await this.controlRequest(pollUrl, access.apiKey, "GET");

    if (!res.ok) {
      // The body is not echoed: an error page is untrusted text and may be long.
      await res.body?.cancel().catch(() => undefined);
      throw new HiggsfieldRequestError(`Higgsfield status check failed (${res.status}).`, { status: res.status });
    }

    let data: any;
    try {
      data = await res.json();
    } catch {
      throw new HiggsfieldRequestError("Higgsfield returned malformed JSON response during polling.", { code: "MALFORMED_RESPONSE" });
    }

    if (!data || typeof data !== "object") {
      throw new HiggsfieldRequestError("Higgsfield status response is not an object.", { code: "MALFORMED_RESPONSE" });
    }
    if (!data.error && typeof data.status !== "string") {
      throw new HiggsfieldRequestError("Higgsfield status response has no status field.", { code: "MALFORMED_RESPONSE" });
    }

    if (data.error) {
      return {
        jobId,
        providerJobId: jobId,
        organizationId: "",
        brandId: "",
        creativeSpec: {} as CreativeSpec,
        providerId: this.id,
        status: "FAILED",
        costEstimateUsd: 0,
        error: data.error,
        errorCode: "UPSTREAM_ERROR",
        lastPolledAt: new Date().toISOString(),
        metadata,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    const isComplete = data.status === "completed" || data.status === "succeeded";
    const isQueued = data.status === "queued";
    const isFailed = data.status === "failed";
    const videoUrl = data.video?.url || data.video_url || data.output?.url;

    return {
      jobId,
      providerJobId: jobId,
      organizationId: "",
      brandId: "",
      creativeSpec: {} as CreativeSpec,
      providerId: this.id,
      status: isComplete ? "RENDERED" : isQueued ? "QUEUED" : isFailed ? "FAILED" : "RUNNING",
      costEstimateUsd: 0,
      outputArtifactId: videoUrl,
      artifactId: videoUrl,
      lastPolledAt: new Date().toISOString(),
      metadata,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Best-effort cancellation, addressed as the status check is. A redirect is an error and is never followed, so it is
   * thrown; a network failure or a non-2xx answer is best-effort and does not throw.
   */
  async cancelJob(jobId: string, metadata?: Record<string, unknown>): Promise<void> {
    const cancelUrl = higgsfieldRequestUrl(jobId, "cancel");
    const owner = typeof metadata?.organizationId === "string" ? metadata.organizationId : undefined;
    const access = await this.keyFor(owner);
    if (!access.ok) return;

    let res: Response;
    try {
      res = await this.controlRequest(cancelUrl, access.apiKey, "POST");
    } catch (err) {
      if (err instanceof HiggsfieldRequestError && err.code === "REDIRECT_REFUSED") throw err;
      // Best-effort cancellation
      return;
    }
    await res.body?.cancel().catch(() => undefined);
  }

  /**
   * One authenticated call to HIGGSFIELD_ORIGIN. Redirects are not followed: a 3xx, or an opaque redirect, becomes a
   * REDIRECT_REFUSED error, so the key is never sent to a location the provider names.
   */
  private async controlRequest(url: string, apiKey: string, method: "GET" | "POST"): Promise<Response> {
    const res = await this.fetchImpl(url, {
      method,
      redirect: "manual",
      headers: {
        Authorization: `Key ${apiKey}`,
      },
      signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
    });
    const isRedirect = res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);
    if (isRedirect) {
      await res.body?.cancel().catch(() => undefined);
      throw new HiggsfieldRequestError(
        `Higgsfield answered with a redirect (${res.status || "opaque"}). The workspace key was not sent to the redirect target.`,
        { status: res.status >= 300 && res.status < 400 ? res.status : undefined, code: "REDIRECT_REFUSED" },
      );
    }
    return res;
  }
}
