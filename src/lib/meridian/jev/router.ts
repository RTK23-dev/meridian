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
import { OpenRouterJevClient, openRouterJevClient, checkEvidenceSufficiency } from "./client.ts";
import { resolveJevConfig } from "./config.ts";
import type { Sql } from "../learning/store.ts";
import { loadDefaultSql, resolveCredential, sharedDefaultOptedIn, type CredentialEnv } from "../credentials/resolve.ts";
import type { CredentialResolution } from "../credentials/contract.ts";

/**
 * Looks up the TypeSafe key for one workspace. The default reads the workspace's saved key, through the shared resolver.
 * A test or another caller can inject a lookup instead of a database.
 */
export type JevCredentialLookup = (organizationId: string) => Promise<CredentialResolution>;

/**
 * The transport's readiness for one workspace. TypeSafe checks the workspace's key. OpenRouter is deployment-only, and it
 * keeps its own health check.
 */
export async function transportHealth(provider: JevProvider, organizationId: string): Promise<JevProviderHealth> {
  const scoped = provider as JevProvider & { healthFor?: (organizationId: string) => Promise<JevProviderHealth> };
  return scoped.healthFor ? scoped.healthFor(organizationId) : provider.health();
}

export class TypeSafeDirectJevProvider implements JevProvider {
  readonly id: JevProviderId = "typesafe_direct";

  private baseUrl?: string;
  private fetchImpl: typeof fetch;
  private readonly sql?: Sql;
  private readonly env?: CredentialEnv;
  private readonly lookup?: JevCredentialLookup;

  /**
   * No key is held here. Each request names its workspace, and the key is looked up for that workspace when the request is
   * made. One process-wide key is therefore never used for another workspace's decision.
   */
  constructor(options?: {
    sql?: Sql;
    env?: CredentialEnv;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    lookup?: JevCredentialLookup;
  }) {
    const config = resolveJevConfig();
    this.baseUrl = options?.baseUrl ?? config.typesafe.baseUrl;
    this.fetchImpl = options?.fetchImpl ?? globalThis.fetch;
    this.sql = options?.sql;
    this.env = options?.env;
    this.lookup = options?.lookup;
  }

  /** The workspace's TypeSafe credential, by the shared resolver. Nothing is cached between requests. */
  async credentialFor(organizationId: string): Promise<CredentialResolution> {
    if (this.lookup) return this.lookup(organizationId);
    const sql = this.sql ?? (await loadDefaultSql());
    return resolveCredential(sql, organizationId, "jev", this.env ?? process.env);
  }

  private getEndpoint(): string {
    const raw = this.baseUrl?.trim() || "https://api.typesafe.ai/v1/systemone";
    if (raw.endsWith("/systemone")) {
      return raw;
    }
    if (raw.endsWith("/v1")) {
      return `${raw}/systemone`;
    }
    if (raw.endsWith("/v1/")) {
      return `${raw}systemone`;
    }
    const clean = raw.replace(/\/+$/, "");
    return `${clean}/v1/systemone`;
  }

  capabilities(): JevCapabilities {
    return {
      primitives: ["noul", "choice", "score"],
      batchDecisions: true,
      explanation: false,
    };
  }

  /**
   * Without a workspace there is no key to check, so this never reports READY. The key is saved per workspace.
   */
  async health(): Promise<JevProviderHealth> {
    return {
      status: "NOT_CONFIGURED",
      message: "The TypeSafe JEV key is saved per workspace, so readiness needs a workspace. No workspace was given.",
    };
  }

  /**
   * Readiness for one workspace, by the same resolution a decision uses. No live request is made.
   *
   * UNAVAILABLE means the workspace's own TypeSafe entry cannot be used, or could not be read. The router treats it as a failure
   * of this workspace's transport, so it never moves the decision to another transport. NOT_CONFIGURED means the workspace has no
   * saved entry and no shared default, which is the only case where another transport may be tried.
   */
  async healthFor(organizationId: string): Promise<JevProviderHealth> {
    let resolution: CredentialResolution;
    try {
      resolution = await this.credentialFor(organizationId);
    } catch {
      return { status: "UNAVAILABLE", message: "The workspace's TypeSafe JEV credential could not be checked. No live request was made." };
    }
    if (resolution.status === "ready") {
      const source = resolution.source === "workspace" ? "this workspace's saved key" : "the deployment's shared default key";
      return { status: "READY", message: `TypeSafe JEV uses ${source}. No live request was made.` };
    }
    if (resolution.status === "unusable") {
      return { status: "UNAVAILABLE", message: `${resolution.reason} No other JEV transport is used in its place.` };
    }
    return { status: "NOT_CONFIGURED", message: resolution.reason };
  }

  async decide(request: JevDecisionRequest): Promise<JevDecisionResponse> {
    // The key is resolved for this request's workspace. When it is not usable, no request is sent.
    let credential: CredentialResolution;
    try {
      credential = await this.credentialFor(request.organizationId);
    } catch {
      credential = { status: "not_configured", reason: "The workspace's TypeSafe JEV credential could not be read. No request was sent." };
    }
    if (credential.status !== "ready") {
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
          abstainReason: credential.reason,
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
    const apiKey = credential.secret;

    // Direct System One endpoint execution
    const model = request.model || "typesafe/jev-1.13";
    const runId = globalThis.crypto.randomUUID();
    const started = Date.now();
    const endpoint = this.getEndpoint();

    const answers: Record<string, JevAnswer> = {};
    const questionsToDispatch: Record<string, any> = {};

    const availableEvidence: string[] = [
      ...(((request.state as any)?.availableEvidence as string[]) || []),
    ];

    if ((request.state as any)?.records && Array.isArray((request.state as any).records)) {
      for (const rec of (request.state as any).records) {
        if (rec.availableEvidence) {
          availableEvidence.push(...rec.availableEvidence);
        }
      }
    }

    for (const [key, qSpec] of Object.entries(request.questions)) {
      const sufficiency = checkEvidenceSufficiency(qSpec, availableEvidence);
      if (!sufficiency.sufficient) {
        answers[key] = {
          questionId: qSpec.id,
          questionVersion: qSpec.version,
          type: qSpec.type,
          model,
          provider: this.id,
          status: "abstain_insufficient_evidence",
          evidenceRefs: [],
          abstainReason: `Missing required evidence: ${sufficiency.missing.join(", ")}`,
          evaluatedAt: new Date().toISOString(),
        };
      } else {
        questionsToDispatch[key] = qSpec;
      }
    }

    if (Object.keys(questionsToDispatch).length === 0) {
      return {
        runId,
        model,
        provider: this.id,
        inputHash: "abstain_insufficient_evidence",
        cached: false,
        latencyMs: Date.now() - started,
        answers,
      };
    }

    const payload = {
      model,
      state: request.state,
      questions: questionsToDispatch,
    };

    try {
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Direct TypeSafe API returned HTTP ${response.status}: ${errorText.slice(0, 300)}`);
      }

      const body = (await response.json()) as any;
      const rawDecisions = body.answers || body.decisions || {};
      const resolvedModel = body.model || model;

      for (const [key, qSpec] of Object.entries(questionsToDispatch)) {
        const rawAns = rawDecisions[key] || rawDecisions[qSpec.id];
        if (rawAns && (rawAns.choice !== undefined || rawAns.noul !== undefined || rawAns.score !== undefined || rawAns.probability !== undefined || rawAns.answer !== undefined)) {
          const prob = rawAns.noul ?? rawAns.probability;
          answers[key] = {
            questionId: qSpec.id,
            questionVersion: qSpec.version,
            type: qSpec.type,
            model: resolvedModel,
            provider: this.id,
            status: "answered",
            choice: rawAns.choice,
            noul: prob,
            score: rawAns.score,
            answer: rawAns.choice ?? prob ?? rawAns.score ?? rawAns.answer,
            probability: prob,
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
            model: resolvedModel,
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
        model: resolvedModel,
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

  /**
   * OpenRouter is deployment-only. Its key is OPENROUTER_API_KEY on this deployment, and no workspace key is used for it.
   * The deployment key is used only when JEV_SHARED_DEFAULT=deployment is set, the same flag that opts in the TypeSafe
   * deployment key. The health check does not depend on a workspace.
   */
  async health(): Promise<JevProviderHealth> {
    if (!sharedDefaultOptedIn("jev")) {
      return {
        status: "NOT_CONFIGURED",
        message: "OpenRouter is deployment-only. Its deployment key is used only when JEV_SHARED_DEFAULT=deployment is set.",
      };
    }
    const key = resolveJevConfig().openrouter.apiKey;
    if (!key) {
      return {
        status: "NOT_CONFIGURED",
        message: "OpenRouter is deployment-only, and OPENROUTER_API_KEY is not set on this deployment.",
      };
    }
    return { status: "READY", message: "OpenRouter uses the deployment's OPENROUTER_API_KEY. No workspace key is used." };
  }

  async decide(request: JevDecisionRequest): Promise<JevDecisionResponse> {
    // Not opted in, or no deployment key: no request is sent, and each question says why.
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
    const config = resolveJevConfig();
    const rawMode = (policy?.mode ?? config.mode).toLowerCase();
    const mode: JevRoutingMode =
      rawMode === "typesafe" || rawMode === "typesafe_direct"
        ? "typesafe_direct"
        : rawMode === "openrouter"
          ? "openrouter"
          : rawMode === "compare"
            ? "compare"
            : "auto";

    const rawPref = (policy?.preferredProvider ?? config.preferredProvider).toLowerCase();
    const preferredProviderId: JevProviderId =
      rawPref === "typesafe" || rawPref === "typesafe_direct"
        ? "typesafe_direct"
        : rawPref === "openrouter"
          ? "openrouter"
          : "typesafe_direct";

    const fallbackEnabled =
      policy?.fallbackEnabled ?? config.fallbackEnabled;

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

      const primary = preferredProviderId === "typesafe_direct" ? directRes : openrouterRes;
      const secondary = preferredProviderId === "typesafe_direct" ? openrouterRes : directRes;

      let agreementCount = 0;
      let totalQuestions = 0;
      const disagreements: Record<string, { primary: unknown; compared: unknown }> = {};

      for (const [qKey, pAns] of Object.entries(primary.answers)) {
        const sAns = secondary.answers[qKey];
        if (!sAns) continue;
        totalQuestions++;
        const pVal = pAns.choice ?? pAns.score ?? pAns.noul ?? pAns.answer;
        const sVal = sAns.choice ?? sAns.score ?? sAns.noul ?? sAns.answer;
        if (pVal !== undefined && sVal !== undefined && pVal === sVal) {
          agreementCount++;
        } else {
          disagreements[qKey] = { primary: pVal, compared: sVal };
        }
      }

      const agreementRate = totalQuestions > 0 ? Math.round((agreementCount / totalQuestions) * 100) / 100 : 1;

      return {
        ...primary,
        comparison: {
          comparedWith: secondary.provider,
          agreementRate,
          disagreements,
          comparedResponse: secondary,
        },
      };
    }

    // AUTO mode: prefer configured provider, fall back on eligible transport failure
    const preferred = this.getProvider(preferredProviderId);
    // Readiness is checked for this request's workspace, so the TypeSafe key is the one this workspace would use.
    const prefHealth = await transportHealth(preferred, request.organizationId);

    if (prefHealth.status === "READY") {
      const resp = await preferred.decide(request);
      // Check if all answers failed with provider_error
      const allFailed = Object.values(resp.answers).every(
        (a) => a.status === "provider_error" || a.status === "not_configured"
      );
      if (allFailed && fallbackEnabled) {
        const fallbackId: JevProviderId =
          preferredProviderId === "typesafe_direct" ? "openrouter" : "typesafe_direct";
        const fallback = this.getProvider(fallbackId);
        const fbHealth = await transportHealth(fallback, request.organizationId);
        if (fbHealth.status === "READY") {
          const fallbackResp = await fallback.decide(request);
          return {
            ...fallbackResp,
            fallbackUsed: true,
            fallbackFrom: preferredProviderId,
            fallbackReason: "Primary provider encountered provider_error on all questions.",
            requestedProvider: preferredProviderId,
            requestedModel: request.model,
          };
        }
      }
      return {
        ...resp,
        requestedProvider: preferredProviderId,
        requestedModel: request.model,
      };
    }

    // Preferred provider is not ready, fall back if enabled. An unusable saved workspace entry is UNAVAILABLE, and it never falls
    // back: the other transport is not used in place of a workspace's own entry that cannot be used
    // (docs/ARCHITECTURE_CONTRACTS.md, section 1.2). The preferred transport then answers not_configured without a request.
    if (fallbackEnabled && prefHealth.status !== "UNAVAILABLE") {
      const fallbackId: JevProviderId =
        preferredProviderId === "typesafe_direct" ? "openrouter" : "typesafe_direct";
      const fallback = this.getProvider(fallbackId);
      const fallbackResp = await fallback.decide(request);
      return {
        ...fallbackResp,
        fallbackUsed: true,
        fallbackFrom: preferredProviderId,
        fallbackReason: `Primary provider ${preferredProviderId} was NOT_CONFIGURED.`,
        requestedProvider: preferredProviderId,
        requestedModel: request.model,
      };
    }

    // Otherwise return preferred decision (which will yield NOT_CONFIGURED answers)
    return preferred.decide(request);
  }
}

export const jevRouter = new JevRouter();
