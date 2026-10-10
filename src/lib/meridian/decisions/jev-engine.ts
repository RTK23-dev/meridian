/**
 * TypeSafe JEV engine adapter.
 *
 * JEV keeps its real structured-decision interface: the existing router sends registry questions to TypeSafe System
 * One directly or through OpenRouter's Decisions route, unchanged. This adapter only puts that router behind the shared
 * `DecisionEngine` contract and adds the lineage every engine records.
 *
 * Within JEV, the transport is chosen by the existing JEV configuration. Moving to the other transport after a failure
 * happens only when MERIDIAN_JEV_FALLBACK_ENABLED=true. Compare mode, which calls both transports for one decision,
 * runs only when it is configured and MERIDIAN_DECISION_SHADOW_ENABLED=true; otherwise the preferred transport alone
 * is called.
 *
 * The JEV client sends text evidence only. JEV is therefore declared text-only here: a decision that requires images is
 * refused as unsupported, and optional images are recorded as not seen.
 */
import { jevRouter } from "../jev/router.ts";
import { resolveJevConfig } from "../jev/config.ts";
import type { JevProviderRouter, JevRoutingPolicy } from "../jev/types.ts";
import {
  abstainAll,
  type DecisionCallContext,
  type DecisionCapabilities,
  type DecisionEngine,
  type DecisionEngineHealth,
  type DecisionRequest,
  type DecisionResult,
} from "./types.ts";

export const JEV_ADAPTER_VERSION = "jev-adapter.v1";

export function decisionShadowEnabled(): boolean {
  return process.env.MERIDIAN_DECISION_SHADOW_ENABLED?.trim().toLowerCase() === "true";
}

export class JevDecisionEngine implements DecisionEngine {
  readonly id = "jev" as const;
  readonly adapterVersion = JEV_ADAPTER_VERSION;
  private readonly router: JevProviderRouter;

  constructor(router: JevProviderRouter = jevRouter) {
    this.router = router;
  }

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

  async health(context?: DecisionCallContext): Promise<DecisionEngineHealth> {
    const transports = await this.router.health(undefined, context);
    const config = resolveJevConfig();
    const preferred = transports[config.preferredProvider];
    if (preferred?.status === "READY") return { status: "READY", message: `JEV via ${config.preferredProvider}.` };
    const anyReady = Object.entries(transports).find(([, health]) => health.status === "READY");
    if (anyReady && config.mode !== "auto") {
      return { status: "READY", message: `JEV via ${anyReady[0]}.` };
    }
    if (anyReady && config.mode === "auto") {
      return {
        status: "DEGRADED",
        message: `The preferred JEV transport ${config.preferredProvider} is not configured; ${anyReady[0]} is, but is used only when it is selected or transport fallback is enabled.`,
      };
    }
    return {
      status: "NOT_CONFIGURED",
      message: "No JEV transport is configured. Save a TypeSafe key in this workspace's settings, or set OPENROUTER_API_KEY on the deployment.",
    };
  }

  /** The routing policy actually applied: explicit configuration only, never a silent second paid call. */
  routingPolicy(): JevRoutingPolicy {
    const config = resolveJevConfig();
    const mode = config.mode === "compare" && !decisionShadowEnabled() ? "auto" : config.mode;
    return { mode, preferredProvider: config.preferredProvider, fallbackEnabled: config.fallbackEnabled };
  }

  async decide(request: DecisionRequest, context?: DecisionCallContext): Promise<DecisionResult> {
    const config = resolveJevConfig();
    const requestedModel =
      request.model ?? (config.preferredProvider === "openrouter" ? config.openrouter.model : config.typesafe.model);
    const imageCount = request.images?.length ?? 0;

    if (imageCount > 0 && request.imagePolicy === "required") {
      const reason = "JEV takes text evidence only; this decision requires images.";
      return {
        runId: globalThis.crypto.randomUUID(),
        model: requestedModel,
        provider: config.preferredProvider,
        inputHash: "not_sent",
        cached: false,
        latencyMs: 0,
        answers: abstainAll(request, { status: "unsupported", reason, model: requestedModel, provider: config.preferredProvider }),
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
    const { images: _images, imagePolicy: _policy, routingPolicy, ...jevRequest } = request;
    void _images;
    void _policy;
    const response = await this.router.decide(jevRequest, routingPolicy ?? this.routingPolicy(), context);
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
