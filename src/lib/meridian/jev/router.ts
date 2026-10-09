/**
 * Dual JEV Provider Router
 * 
 * Supports both TypeSafe Direct and OpenRouter JEV routes:
 * - Direct TypeSafe AI JEV client (uses official direct endpoint/API key)
 * - OpenRouter-routed JEV (uses native Decisions API with typesafe/jev-1.13)
 * - Router modes: AUTO, TYPESAFE_DIRECT, OPENROUTER, COMPARE
 * 
 * Rules:
 * - Truthfulness outranks completeness: if unconfigured, returns NOT_CONFIGURED.
 * - Never masquerade chat-completion as JEV.
 * - Preserve exact provider identity in decisions and answers.
 */

import type {
  JevProvider,
  JevProviderId,
  JevCapabilities,
  JevProviderHealth,
  JevDecisionRequest,
  JevDecisionResponse,
  JevRoutingPolicy,
  JevRoutingMode,
  JevProviderRouter,
  JevAnswer,
} from "./types.ts";
import { OpenRouterJevClient, openRouterJevClient } from "./client.ts";

export class TypeSafeDirectJevProvider implements JevProvider {
  readonly id: JevProviderId = "typesafe_direct";

  private apiKey?: string;
  private baseUrl?: string;
  private fetchImpl: typeof fetch;

  constructor(options?: {
    apiKey?: string;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
  }) {
    this.apiKey = options?.apiKey ?? process.env.TYPESAFE_JEV_API_KEY?.trim();
    this.baseUrl = options?.baseUrl ?? process.env.TYPESAFE_JEV_BASE_URL?.trim() ?? "https://api.typesafe.ai/v1";
    this.fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  }

  capabilities(): JevCapabilities {
    return {
      primitives: ["noul", "choice", "score"],
      batchDecisions: true,
      explanation: false,
    };
  }

  async health(): Promise<JevProviderHealth> {
    if (!this.apiKey) {
      return {
        status: "NOT_CONFIGURED",
        message: "TYPESAFE_JEV_API_KEY is not configured for direct TypeSafe JEV.",
      };
    }
    return { status: "READY" };
  }

  async decide(request: JevDecisionRequest): Promise<JevDecisionResponse> {
    const health = await this.health();
    if (health.status !== "READY") {
      const answers: Record<string, JevAnswer> = {};
      const now = new Date().toISOString();
      for (const [key, q] of Object.entries(request.questions)) {
        answers[key] = {
          questionId: q.id,
          questionVersion: q.version,
          type: q.type,
          model: request.model ?? "typesafe/jev-1.13",
          provider: this.id,
          status: "not_configured",
          evidenceRefs: [],
          abstainReason: health.message,
          evaluatedAt: now,
        };
      }
      return {
        runId: globalThis.crypto.randomUUID(),
        model: request.model ?? "typesafe/jev-1.13",
        provider: this.id,
        inputHash: "not_configured",
        cached: false,
        latencyMs: 0,
        answers,
      };
    }

    // Direct endpoint execution
    const model = request.model || "typesafe/jev-1.13";
    const runId = globalThis.crypto.randomUUID();
    const started = Date.now();

    const payload = {
      model,
      state: request.state,
      questions: request.questions,
    };

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/decisions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Direct TypeSafe API returned HTTP ${response.status}: ${errorText.slice(0, 300)}`);
      }

      const body = (await response.json()) as any;
      const answers: Record<string, JevAnswer> = {};
      const rawDecisions = body.decisions || body.answers || {};

      for (const [key, qSpec] of Object.entries(request.questions)) {
        const rawAns = rawDecisions[key] || rawDecisions[qSpec.id];
        if (rawAns) {
          answers[key] = {
            questionId: qSpec.id,
            questionVersion: qSpec.version,
            type: qSpec.type,
            model,
            provider: this.id,
            status: "answered",
            choice: rawAns.choice,
            noul: rawAns.noul ?? rawAns.probability,
            score: rawAns.score,
            answer: rawAns.choice ?? rawAns.noul ?? rawAns.score ?? rawAns.answer,
            probability: rawAns.noul ?? rawAns.probability,
            probabilities: rawAns.probabilities,
            confidence: qSpec.type === "noul" ? undefined : rawAns.confidence,
            legend: rawAns.legend,
            evidenceRefs: rawAns.evidenceRefs ?? [],
            evaluatedAt: new Date().toISOString(),
          };
        } else {
          answers[key] = {
            questionId: qSpec.id,
            questionVersion: qSpec.version,
            type: qSpec.type,
            model,
            provider: this.id,
            status: "abstain_uncertain",
            evidenceRefs: [],
            abstainReason: "Direct TypeSafe provider returned no decision for this question.",
            evaluatedAt: new Date().toISOString(),
          };
        }
      }

      return {
        runId,
        model,
        provider: this.id,
        inputHash: body.inputHash ?? runId,
        cached: false,
        latencyMs: Date.now() - started,
        answers,
      };
    } catch (err: any) {
      const answers: Record<string, JevAnswer> = {};
      for (const [key, qSpec] of Object.entries(request.questions)) {
        answers[key] = {
          questionId: qSpec.id,
          questionVersion: qSpec.version,
          type: qSpec.type,
          model,
          provider: this.id,
          status: "provider_error",
          evidenceRefs: [],
          abstainReason: err.message,
          evaluatedAt: new Date().toISOString(),
        };
      }
      return {
        runId,
        model,
        provider: this.id,
        inputHash: "error",
        cached: false,
        latencyMs: Date.now() - started,
        answers,
      };
    }
  }
}

export class OpenRouterJevProvider implements JevProvider {
  readonly id: JevProviderId = "openrouter";
  private client: OpenRouterJevClient;

  constructor(client: OpenRouterJevClient = openRouterJevClient) {
    this.client = client;
  }

  capabilities(): JevCapabilities {
    return {
      primitives: ["noul", "choice", "score"],
      batchDecisions: true,
      explanation: false,
    };
  }

  async health(): Promise<JevProviderHealth> {
    const key = process.env.OPENROUTER_API_KEY?.trim();
    if (!key) {
      return {
        status: "NOT_CONFIGURED",
        message: "OPENROUTER_API_KEY is not configured.",
      };
    }
    return { status: "READY" };
  }

  async decide(request: JevDecisionRequest): Promise<JevDecisionResponse> {
    const res = await this.client.decide(request);
    return {
      ...res,
      provider: this.id,
    };
  }
}

export class JevRouter implements JevProviderRouter {
  private providers: Map<JevProviderId, JevProvider> = new Map();

  constructor(options?: {
    typesafeProvider?: JevProvider;
    openrouterProvider?: JevProvider;
  }) {
    this.providers.set(
      "typesafe_direct",
      options?.typesafeProvider ?? new TypeSafeDirectJevProvider()
    );
    this.providers.set(
      "openrouter",
      options?.openrouterProvider ?? new OpenRouterJevProvider()
    );
  }

  getProvider(id: JevProviderId): JevProvider {
    const p = this.providers.get(id);
    if (!p) {
      throw new Error(`Unknown JEV provider: ${id}`);
    }
    return p;
  }

  async health(id?: JevProviderId): Promise<Record<JevProviderId, JevProviderHealth>> {
    if (id) {
      return { [id]: await this.getProvider(id).health() } as Record<JevProviderId, JevProviderHealth>;
    }
    const result: Record<string, JevProviderHealth> = {};
    for (const [pId, prov] of this.providers.entries()) {
      result[pId] = await prov.health();
    }
    return result as Record<JevProviderId, JevProviderHealth>;
  }

  async decide(
    request: JevDecisionRequest,
    policy?: JevRoutingPolicy
  ): Promise<JevDecisionResponse> {
    const mode: JevRoutingMode =
      policy?.mode ??
      (process.env.MERIDIAN_JEV_PROVIDER_MODE as JevRoutingMode) ??
      "auto";

    const preferredProviderId: JevProviderId =
      policy?.preferredProvider ??
      (process.env.MERIDIAN_JEV_PREFERRED_PROVIDER as JevProviderId) ??
      (process.env.TYPESAFE_JEV_API_KEY ? "typesafe_direct" : "openrouter");

    const fallbackEnabled =
      policy?.fallbackEnabled ??
      (process.env.MERIDIAN_JEV_FALLBACK_ENABLED !== "false");

    if (mode === "typesafe_direct") {
      return this.getProvider("typesafe_direct").decide(request);
    }

    if (mode === "openrouter") {
      return this.getProvider("openrouter").decide(request);
    }

    if (mode === "compare") {
      const [directRes, openrouterRes] = await Promise.all([
        this.getProvider("typesafe_direct").decide(request),
        this.getProvider("openrouter").decide(request),
      ]);
      // Return preferred provider with comparison attached in answer metadata if needed
      return preferredProviderId === "typesafe_direct" ? directRes : openrouterRes;
    }

    // AUTO mode: prefer configured provider, fall back on NOT_CONFIGURED or transport failure
    const preferred = this.getProvider(preferredProviderId);
    const prefHealth = await preferred.health();

    if (prefHealth.status === "READY") {
      const resp = await preferred.decide(request);
      // Check if all answers failed with provider_error
      const allFailed = Object.values(resp.answers).every(
        (a) => a.status === "provider_error"
      );
      if (allFailed && fallbackEnabled) {
        const fallbackId: JevProviderId =
          preferredProviderId === "typesafe_direct" ? "openrouter" : "typesafe_direct";
        const fallback = this.getProvider(fallbackId);
        const fbHealth = await fallback.health();
        if (fbHealth.status === "READY") {
          return fallback.decide(request);
        }
      }
      return resp;
    }

    // Preferred provider is not ready, fall back if enabled
    if (fallbackEnabled) {
      const fallbackId: JevProviderId =
        preferredProviderId === "typesafe_direct" ? "openrouter" : "typesafe_direct";
      const fallback = this.getProvider(fallbackId);
      return fallback.decide(request);
    }

    // Otherwise return preferred decision (which will yield NOT_CONFIGURED answers)
    return preferred.decide(request);
  }
}

export const jevRouter = new JevRouter();
