/**
 * JEV decision engine adapter.
 *
 * JEV is Meridian's semantic decision layer: its question registry, evidence rules, answer validation, abstentions and calibration
 * stance stay the same whichever model service answers. The workspace chooses that service (decisions/jev-backend.ts):
 *
 *   typesafe_direct  TypeSafe System One directly, through the existing JEV router, with the workspace's TypeSafe key. The default.
 *   openrouter       OpenRouter's Decisions API, through the OpenRouter Decisions engine, with the workspace's OpenRouter key and
 *                    its selected decision model.
 *
 * Exactly one backend is called for a decision. There is no fallback between backends, and an unreadable backend setting fails
 * closed. The shared gate and dispatcher still record the decision's lineage.
 *
 * JEV's TypeSafe request carries text evidence only, so the TypeSafe path is declared text-only here, and a decision that requires
 * images is refused as unsupported there. The OpenRouter backend can take images, but the shared gate removes images before any
 * engine call for an engine declared text-only, so images do not reach it through JEV yet. That limit is documented in DECISIONS.md.
 */
import { jevRouter, transportHealth } from "../jev/router.ts";
import { resolveJevConfig } from "../jev/config.ts";
import type { JevProviderRouter } from "../jev/types.ts";
import { DEFAULT_JEV_BACKEND, databaseJevBackendStore, type JevBackend, type JevBackendStore } from "./jev-backend.ts";
import { OpenRouterDecisionsEngine } from "./openrouter-engine.ts";
import {
  abstainAll,
  type DecisionCapabilities,
  type DecisionEngine,
  type DecisionEngineHealth,
  type DecisionRequest,
  type DecisionResult,
} from "./types.ts";

export const JEV_ADAPTER_VERSION = "jev-adapter.v1";

export type JevEngineOptions = {
  /** The OpenRouter Decisions engine, used when the workspace's JEV backend is OpenRouter. The registry passes its own. */
  openrouter?: OpenRouterDecisionsEngine;
  /** How the workspace's JEV backend is read. The database by default. */
  backends?: JevBackendStore;
};

export class JevDecisionEngine implements DecisionEngine {
  readonly id = "jev" as const;
  readonly adapterVersion = JEV_ADAPTER_VERSION;
  private readonly router: JevProviderRouter;
  private readonly openrouter: OpenRouterDecisionsEngine;
  private readonly backends: JevBackendStore;

  constructor(router: JevProviderRouter = jevRouter, options: JevEngineOptions = {}) {
    this.router = router;
    this.openrouter = options.openrouter ?? new OpenRouterDecisionsEngine();
    this.backends = options.backends ?? databaseJevBackendStore;
  }

  /**
   * The capabilities of the TypeSafe path, which is the static declaration. The OpenRouter backend is reported by the
   * `openrouter-decisions` engine, and the shared gate decides which evidence reaches JEV.
   */
  capabilities(): DecisionCapabilities {
    return {
      engineId: this.id,
      questionKinds: ["predicate", "choice", "score"],
      inputModalities: ["text"],
      maxImages: 0,
      maxImageBytes: 0,
      imageMimeTypes: [],
      batchQuestions: true,
      reportsUsage: false,
      semantics: {
        predicate: "probability",
        choice: "categorical_with_confidence",
        score: "ordered_level_expectation",
      },
    };
  }

  /** Without a workspace, no backend or key can be checked, so this never reports READY. */
  async health(): Promise<DecisionEngineHealth> {
    return {
      status: "NOT_CONFIGURED",
      message: "JEV keys and its backend are saved per workspace. No workspace was given, so nothing was checked.",
    };
  }

  /**
   * Readiness for one workspace, for the backend that workspace has chosen. No live request is made. An unreadable backend
   * setting is UNAVAILABLE, never a silent default.
   */
  async healthFor(organizationId: string): Promise<DecisionEngineHealth> {
    const backend = await this.backendFor(organizationId);
    if (!backend.ok) return { status: "UNAVAILABLE", message: backend.reason };
    return this.healthForBackend(organizationId, backend.backend);
  }

  /**
   * Readiness of one named backend for a workspace, without changing the stored choice. It is what a switch to that backend is
   * checked against. No live request is made.
   */
  async healthForBackend(organizationId: string, backend: JevBackend): Promise<DecisionEngineHealth> {
    if (backend === "openrouter") {
      const health = await this.openrouter.healthFor(organizationId);
      return { ...health, message: `JEV via OpenRouter. ${health.message}` } as DecisionEngineHealth;
    }
    const health = await transportHealth(this.router.getProvider("typesafe_direct"), organizationId);
    if (health.status === "READY") return { status: "READY", message: `JEV via TypeSafe. ${health.message ?? ""}`.trim() };
    return { status: "NOT_CONFIGURED", message: health.message ?? "No TypeSafe key is saved for this workspace." };
  }


  async decide(request: DecisionRequest): Promise<DecisionResult> {
    // The gate resolves the backend once for the decision. It is read here only when a caller did not resolve it.
    const backend: { ok: true; backend: "typesafe_direct" | "openrouter" } | { ok: false; reason: string } = request.resolved?.jevBackend
      ? { ok: true, backend: request.resolved.jevBackend }
      : await this.backendFor(request.organizationId);
    if (!backend.ok) {
      // The backend is unknown, so nothing is sent to any service. The decision is refused, and no other backend is tried.
      const requestedModel = request.model ?? "";
      return {
        runId: globalThis.crypto.randomUUID(),
        model: requestedModel,
        provider: "jev",
        inputHash: "not_sent",
        cached: false,
        latencyMs: 0,
        answers: abstainAll(request, { status: "not_configured", reason: backend.reason, model: requestedModel, provider: "jev" }),
        engineId: this.id,
        adapterVersion: this.adapterVersion,
        requestedModel,
        returnedModel: requestedModel,
        inputModality: "text",
        imageCount: 0,
        imagesOmitted: 0,
        failure: { kind: "not_configured", message: backend.reason },
      };
    }
    if (backend.backend === "openrouter") {
      // JEV through OpenRouter: the same request, answered by the OpenRouter Decisions engine with the workspace's model. The
      // result is recorded as a JEV decision, with OpenRouter as the provider that served it.
      const result = await this.openrouter.decide(request);
      return { ...result, engineId: this.id, adapterVersion: this.adapterVersion };
    }
    return this.decideWithTypeSafe(request);
  }

  /** The workspace's JEV backend. An unset backend is the documented default, TypeSafe; an unreadable one is a refusal. */
  private async backendFor(organizationId: string | undefined): Promise<{ ok: true; backend: "typesafe_direct" | "openrouter" } | { ok: false; reason: string }> {
    if (!organizationId) return { ok: true, backend: DEFAULT_JEV_BACKEND };
    const read = await this.backends.read(organizationId);
    if (!read.ok) return { ok: false, reason: read.reason };
    return { ok: true, backend: read.backend ?? DEFAULT_JEV_BACKEND };
  }

  private async decideWithTypeSafe(request: DecisionRequest): Promise<DecisionResult> {
    const config = resolveJevConfig();
    const requestedModel = request.model ?? config.typesafe.model;
    const imageCount = request.images?.length ?? 0;
    if (imageCount > 0 && request.imagePolicy === "required") {
      const reason = "JEV takes text evidence only; this decision requires images.";
      return {
        runId: globalThis.crypto.randomUUID(),
        model: requestedModel,
        provider: "typesafe_direct",
        inputHash: "not_sent",
        cached: false,
        latencyMs: 0,
        answers: abstainAll(request, { status: "unsupported", reason, model: requestedModel, provider: "typesafe_direct" }),
        engineId: this.id,
        adapterVersion: this.adapterVersion,
        requestedModel,
        returnedModel: requestedModel,
        inputModality: "text+image",
        imageCount,
        imagesOmitted: imageCount,
        failure: { kind: "unsupported_input", message: reason },
      };
    }

    // The JEV request carries no image bytes: images are never forwarded to a text-only route.
    const { images: _images, imagePolicy: _policy, ...jevRequest } = request;
    void _images;
    void _policy;
    const response = await this.router.decide(jevRequest);
    // Give every answered value the same semantics and calibration fields the other engine returns.
    for (const answer of Object.values(response.answers)) {
      if (answer.status !== "answered") continue;
      answer.semantics = answer.type === "noul" ? "probability" : answer.type === "score" ? "ordered_score" : "categorical";
      answer.calibrationStatus = "uncalibrated";
    }
    const answers = Object.values(response.answers);
    const allNotConfigured = answers.length > 0 && answers.every((answer) => answer.status === "not_configured");
    const allProviderError = answers.length > 0 && answers.every((answer) => answer.status === "provider_error");
    return {
      ...response,
      engineId: this.id,
      adapterVersion: this.adapterVersion,
      requestedModel,
      returnedModel: response.model,
      inputModality: "text",
      imageCount: 0,
      imagesOmitted: imageCount,
      failure: allNotConfigured
        ? { kind: "not_configured", message: answers[0]?.abstainReason ?? "JEV is not configured." }
        : allProviderError
          ? { kind: "provider_unavailable", message: answers[0]?.abstainReason ?? "JEV returned an error." }
          : undefined,
    };
  }
}
