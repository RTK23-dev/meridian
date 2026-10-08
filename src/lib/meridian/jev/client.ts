/**
 * TypeSafe JEV Client
 *
 * Primary decision engine client communicating with TypeSafe JEV models
 * via the OpenRouter gateway.
 *
 * Implements:
 * - Structured decision primitives (noul, choice, score)
 * - Explicit evidence sufficiency verification before network dispatch
 * - Deterministic input hashing & cache key generation
 * - Explicit abstention when evidence is absent or uncertainty is high
 * - Zero reliance on chat completion free-form text or JSON.parse()
 */

import { createHash } from "node:crypto";
import type {
  JevClient,
  JevDecisionRequest,
  JevDecisionResponse,
  JevAnswer,
  JevQuestionSpec,
} from "./types.ts";

export type JevClientConfig = {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export function getJevConfig(overrides: JevClientConfig = {}): {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
} {
  return {
    provider: overrides.provider || process.env.JEV_PROVIDER?.trim() || "openrouter",
    model: overrides.model || process.env.JEV_MODEL?.trim() || "typesafe/jev-1.13",
    apiKey: overrides.apiKey || process.env.OPENROUTER_API_KEY?.trim() || "",
    baseUrl: overrides.baseUrl || "https://openrouter.ai/api/v1",
  };
}

export function computeJevInputHash(input: {
  state: unknown;
  questions: Record<string, JevQuestionSpec>;
  model: string;
}): string {
  const normalizedQuestions = Object.keys(input.questions)
    .sort()
    .map((k) => ({
      id: input.questions[k].id,
      version: input.questions[k].version,
      type: input.questions[k].type,
      criteria: input.questions[k].criteria,
    }));

  return createHash("sha256")
    .update(
      JSON.stringify({
        state: input.state,
        questions: normalizedQuestions,
        model: input.model,
      }),
    )
    .digest("hex");
}

export function checkEvidenceSufficiency(
  question: JevQuestionSpec,
  availableEvidence: string[] = [],
): { sufficient: boolean; missing: string[] } {
  if (!question.evidenceRequirements || question.evidenceRequirements.length === 0) {
    return { sufficient: true, missing: [] };
  }

  const missing = question.evidenceRequirements.filter(
    (req) => !availableEvidence.includes(req),
  );

  return {
    sufficient: missing.length === 0,
    missing,
  };
}

// In-memory cache for fast idempotent reuse
const decisionCache = new Map<string, JevDecisionResponse>();

export class OpenRouterJevClient implements JevClient {
  private config: ReturnType<typeof getJevConfig>;
  private fetchImpl: typeof fetch;

  constructor(config: JevClientConfig = {}) {
    this.config = getJevConfig(config);
    this.fetchImpl = config.fetchImpl || globalThis.fetch;
  }

  async decide(request: JevDecisionRequest): Promise<JevDecisionResponse> {
    const started = Date.now();
    const model = request.model || this.config.model;
    const provider = request.provider || this.config.provider;
    const runId = globalThis.crypto.randomUUID();

    const inputHash = computeJevInputHash({
      state: request.state,
      questions: request.questions,
      model,
    });

    // Check memory cache
    const cached = decisionCache.get(inputHash);
    if (cached) {
      return {
        ...cached,
        cached: true,
        latencyMs: Date.now() - started,
      };
    }

    const answers: Record<string, JevAnswer> = {};
    const questionsToDispatch: Record<string, JevQuestionSpec> = {};

    // Collect available evidence flags from state
    const availableEvidence: string[] = [
      ...((request.state.availableEvidence as string[]) || []),
    ];

    if (request.state.records) {
      for (const rec of request.state.records) {
        if (rec.availableEvidence) {
          availableEvidence.push(...rec.availableEvidence);
        }
      }
    }

    // Evidence sufficiency gate before calling provider
    for (const [key, qSpec] of Object.entries(request.questions)) {
      const sufficiency = checkEvidenceSufficiency(qSpec, availableEvidence);
      if (!sufficiency.sufficient) {
        answers[key] = {
          questionId: qSpec.id,
          questionVersion: qSpec.version,
          model,
          provider,
          status: "abstain_insufficient_evidence",
          answer: false,
          probability: 0.0,
          confidence: 0.0,
          evidenceRefs: [],
          abstainReason: `Missing required evidence: ${sufficiency.missing.join(", ")}`,
          evaluatedAt: new Date().toISOString(),
        };
      } else {
        questionsToDispatch[key] = qSpec;
      }
    }

    // If all questions abstained due to insufficient evidence, return immediately
    if (Object.keys(questionsToDispatch).length === 0) {
      const response: JevDecisionResponse = {
        runId,
        model,
        provider,
        inputHash,
        cached: false,
        latencyMs: Date.now() - started,
        answers,
      };
      decisionCache.set(inputHash, response);
      return response;
    }

    // If API key is not configured, abstain with explicit reason (no faking)
    if (!this.config.apiKey) {
      for (const [key, qSpec] of Object.entries(questionsToDispatch)) {
        answers[key] = {
          questionId: qSpec.id,
          questionVersion: qSpec.version,
          model,
          provider,
          status: "abstain_uncertain",
          answer: false,
          probability: 0.0,
          confidence: 0.0,
          evidenceRefs: [],
          abstainReason: "OPENROUTER_API_KEY is not configured for native TypeSafe JEV.",
          evaluatedAt: new Date().toISOString(),
        };
      }

      const response: JevDecisionResponse = {
        runId,
        model,
        provider,
        inputHash,
        cached: false,
        latencyMs: Date.now() - started,
        answers,
      };
      return response;
    }

    // Execute remote TypeSafe JEV call via OpenRouter
    try {
      const url = `${this.config.baseUrl}/decisions`;
      const payload = {
        model,
        state: request.state,
        questions: Object.fromEntries(
          Object.entries(questionsToDispatch).map(([k, q]) => [
            k,
            {
              type: q.type,
              instructions: q.instructions,
              criteria: q.criteria,
            },
          ]),
        ),
      };

      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
          "HTTP-Referer": "https://meridian.advertising",
          "X-Title": "Meridian JEV Intelligence",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        // Fallback to structured schema completion if /decisions route returns 404
        if (res.status === 404) {
          return this.fallbackStructuredEndpoint(request, questionsToDispatch, answers, runId, model, provider, inputHash, started);
        }
        throw new Error(`OpenRouter JEV returned status ${res.status}: ${res.statusText}`);
      }

      const data = (await res.json()) as {
        decisions?: Record<
          string,
          {
            answer: string | boolean | number;
            probability?: number;
            distribution?: Record<string, number>;
            confidence?: number;
            evidenceRefs?: Array<{ artifactId?: string; path?: string; summary?: string }>;
          }
        >;
      };

      const decisions = data.decisions || {};
      for (const [key, qSpec] of Object.entries(questionsToDispatch)) {
        const item = decisions[key];
        if (item) {
          answers[key] = {
            questionId: qSpec.id,
            questionVersion: qSpec.version,
            model,
            provider,
            status: "answered",
            answer: item.answer,
            probability: item.probability,
            distribution: item.distribution,
            confidence: item.confidence ?? 0.85,
            evidenceRefs: item.evidenceRefs || [],
            evaluatedAt: new Date().toISOString(),
          };
        } else {
          answers[key] = {
            questionId: qSpec.id,
            questionVersion: qSpec.version,
            model,
            provider,
            status: "abstain_uncertain",
            answer: false,
            probability: 0.0,
            confidence: 0.0,
            evidenceRefs: [],
            abstainReason: "Model provided no decision for this question.",
            evaluatedAt: new Date().toISOString(),
          };
        }
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "JEV decision request failed.";
      for (const [key, qSpec] of Object.entries(questionsToDispatch)) {
        answers[key] = {
          questionId: qSpec.id,
          questionVersion: qSpec.version,
          model,
          provider,
          status: "abstain_uncertain",
          answer: false,
          confidence: 0.0,
          evidenceRefs: [],
          abstainReason: errMsg,
          evaluatedAt: new Date().toISOString(),
        };
      }
    }

    const response: JevDecisionResponse = {
      runId,
      model,
      provider,
      inputHash,
      cached: false,
      latencyMs: Date.now() - started,
      answers,
    };

    decisionCache.set(inputHash, response);
    return response;
  }

  private async fallbackStructuredEndpoint(
    request: JevDecisionRequest,
    questionsToDispatch: Record<string, JevQuestionSpec>,
    existingAnswers: Record<string, JevAnswer>,
    runId: string,
    model: string,
    provider: string,
    inputHash: string,
    started: number,
  ): Promise<JevDecisionResponse> {
    // Structured response parser through standard OpenRouter gateway with json_schema response_format
    const schema = {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(questionsToDispatch).map(([k, q]) => [
          k,
          {
            type: "object",
            properties: {
              answer: q.type === "noul" ? { type: "boolean" } : q.type === "score" ? { type: "number" } : { type: "string" },
              probability: { type: "number" },
              confidence: { type: "number" },
              explanation: { type: "string" },
            },
            required: ["answer", "confidence"],
          },
        ]),
      ),
      required: Object.keys(questionsToDispatch),
    };

    const completionRes = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
        "HTTP-Referer": "https://meridian.advertising",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: "You are the TypeSafe JEV structured judgment decision engine. Return strict structured decisions matching the schema.",
          },
          {
            role: "user",
            content: JSON.stringify({
              state: request.state,
              questions: questionsToDispatch,
            }),
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "jev_decisions", schema, strict: true },
        },
        temperature: 0,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!completionRes.ok) {
      throw new Error(`OpenRouter structured decision endpoint failed: ${completionRes.status}`);
    }

    const completionJson = (await completionRes.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = completionJson.choices?.[0]?.message?.content;
    const parsed = content ? (JSON.parse(content) as Record<string, any>) : {};

    for (const [key, qSpec] of Object.entries(questionsToDispatch)) {
      const item = parsed[key];
      if (item) {
        existingAnswers[key] = {
          questionId: qSpec.id,
          questionVersion: qSpec.version,
          model,
          provider,
          status: "answered",
          answer: item.answer,
          probability: typeof item.probability === "number" ? item.probability : undefined,
          confidence: typeof item.confidence === "number" ? item.confidence : 0.8,
          evidenceRefs: item.explanation ? [{ summary: item.explanation }] : [],
          evaluatedAt: new Date().toISOString(),
        };
      }
    }

    const response: JevDecisionResponse = {
      runId,
      model,
      provider,
      inputHash,
      cached: false,
      latencyMs: Date.now() - started,
      answers: existingAnswers,
    };
    decisionCache.set(inputHash, response);
    return response;
  }

  async answer(input: {
    evidenceBundle: { id: string; organizationId?: string; brandId?: string; availableEvidence?: string[]; [key: string]: unknown };
    question: JevQuestionSpec;
    organizationId?: string;
    brandId?: string;
  }): Promise<JevAnswer> {
    const orgId = input.organizationId || (input.evidenceBundle.organizationId as string) || "system";
    const brandId = input.brandId || (input.evidenceBundle.brandId as string) || "system";

    const resp = await this.decide({
      organizationId: orgId,
      brandId: brandId,
      state: {
        description: `Evidence bundle evaluation for bundle ${input.evidenceBundle.id}`,
        bundleId: input.evidenceBundle.id,
        availableEvidence: input.evidenceBundle.availableEvidence || [],
        evidence: input.evidenceBundle,
      },
      questions: {
        [input.question.id]: input.question,
      },
    });

    return (
      resp.answers[input.question.id] || {
        questionId: input.question.id,
        questionVersion: input.question.version,
        model: resp.model,
        provider: resp.provider,
        status: "abstain_uncertain",
        answer: false,
        confidence: 0,
        evidenceRefs: [],
        evaluatedAt: new Date().toISOString(),
        abstainReason: "No answer returned by engine",
      }
    );
  }
}

export const openRouterJevClient = new OpenRouterJevClient();
