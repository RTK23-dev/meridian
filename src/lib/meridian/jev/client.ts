/**
 * TypeSafe JEV Client
 *
 * Primary decision engine client communicating with TypeSafe JEV models
 * via OpenRouter's Decisions API at POST https://openrouter.ai/api/alpha/decisions.
 *
 * Implements:
 * - Structured decision primitives: noul (probability), choice (one-of-N), score (ordered degree)
 * - Explicit evidence sufficiency verification before network dispatch
 * - Deterministic input hashing & DB-backed cache key generation
 * - Explicit abstention when evidence is absent or uncertainty is high
 * - Zero reliance on chat completion free-form text or generic LLM fallbacks
 * - Exact evidence refs preserved for full provenance
 */

import { createHash } from "node:crypto";
import type {
  JevClient,
  JevDecisionRequest,
  JevDecisionResponse,
  JevAnswer,
  JevQuestionSpec,
  EvidenceRef,
} from "./types.ts";

export type JevClientConfig = {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sql?: any;
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
    baseUrl: overrides.baseUrl || process.env.JEV_BASE_URL?.trim() || "https://openrouter.ai/api/alpha",
  };
}

export function computeJevInputHash(input: {
  state: unknown;
  questions: Record<string, JevQuestionSpec>;
  model: string;
}): string {
  const normalizedQuestions = Object.keys(input.questions)
    .sort()
    .map((k) => {
      const q = input.questions[k];
      return {
        id: q.id,
        version: q.version,
        type: q.type,
        instructions: q.instructions,
        criteria: q.criteria,
        levels: q.levels,
        options: q.options,
        evidenceRequirements: q.evidenceRequirements,
        policyMapping: (q as any).policyMapping,
      };
    });

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

// In-memory cache for fast local lookup
const memoryDecisionCache = new Map<string, JevDecisionResponse>();

/**
 * Minimizes state before sending to remote JEV API, stripping out unneeded secrets,
 * raw database columns, and irrelevant internal identifiers.
 */
function minimizeJevState(state: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};

  if (state.description) clean.description = state.description;
  if (state.content) clean.content = state.content;
  if (state.performance) clean.performance = state.performance;
  if (state.controls) clean.controls = state.controls;
  if (state.records) clean.records = state.records;
  if (state.availableEvidence) clean.availableEvidence = state.availableEvidence;
  if (state.evidenceRefs) clean.evidenceRefs = state.evidenceRefs;

  // If none of the structured fields matched, pass through non-sensitive fields
  if (Object.keys(clean).length === 0) {
    for (const [k, v] of Object.entries(state)) {
      if (!k.toLowerCase().includes("secret") && !k.toLowerCase().includes("token") && !k.toLowerCase().includes("password")) {
        clean[k] = v;
      }
    }
  }

  return clean;
}

export class OpenRouterJevClient implements JevClient {
  private config: ReturnType<typeof getJevConfig>;
  private fetchImpl: typeof fetch;
  private sql?: any;

  constructor(config: JevClientConfig = {}) {
    this.config = getJevConfig(config);
    this.fetchImpl = config.fetchImpl || globalThis.fetch;
    this.sql = config.sql;
  }

  async decide(request: JevDecisionRequest): Promise<JevDecisionResponse> {
    const started = Date.now();
    const model = request.model || this.config.model;
    const provider = request.provider || this.config.provider;
    const runId = globalThis.crypto.randomUUID();

    const cleanState = minimizeJevState(request.state);

    const inputHash = computeJevInputHash({
      state: cleanState,
      questions: request.questions,
      model,
    });

    // 1. Check memory cache
    const cached = memoryDecisionCache.get(inputHash);
    if (cached) {
      return {
        ...cached,
        cached: true,
        latencyMs: Date.now() - started,
      };
    }

    // 2. Check DB cache if SQL client is configured
    if (this.sql) {
      try {
        const dbRuns = await this.sql<{ id: string; answers: unknown }>`
          select r.id, json_agg(a.*) as answers
          from jev_runs r
          join jev_answers a on a.run_id = r.id
          where r.input_hash = ${inputHash}
            and r.status = 'completed'
          group by r.id
          limit 1
        `;
        if (dbRuns.length > 0 && dbRuns[0]) {
          const row = dbRuns[0];
          const rawAnswers = (row.answers as any[]) || [];
          const reconstructedAnswers: Record<string, JevAnswer> = {};
          for (const ans of rawAnswers) {
            reconstructedAnswers[ans.question_id] = {
              questionId: ans.question_id,
              questionVersion: ans.question_version,
              model: ans.model,
              provider: ans.provider,
              status: ans.status,
              answer: ans.answer,
              probability: ans.probability ?? undefined,
              confidence: ans.confidence ?? undefined,
              evidenceRefs: ans.evidence || [],
              evaluatedAt: ans.created_at,
            };
          }
          if (Object.keys(reconstructedAnswers).length > 0) {
            const resp: JevDecisionResponse = {
              runId: row.id,
              model,
              provider,
              inputHash,
              cached: true,
              latencyMs: Date.now() - started,
              answers: reconstructedAnswers,
            };
            memoryDecisionCache.set(inputHash, resp);
            return resp;
          }
        }
      } catch {
        // Non-fatal
      }
    }

    const answers: Record<string, JevAnswer> = {};
    const questionsToDispatch: Record<string, JevQuestionSpec> = {};

    // Collect available evidence flags and evidence refs from state
    const availableEvidence: string[] = [
      ...((cleanState.availableEvidence as string[]) || []),
    ];

    const inputEvidenceRefs: EvidenceRef[] = (cleanState.evidenceRefs as EvidenceRef[]) || [];

    if (cleanState.records && Array.isArray(cleanState.records)) {
      for (const rec of cleanState.records as any[]) {
        if (rec.availableEvidence) {
          availableEvidence.push(...rec.availableEvidence);
        }
      }
    }

    // Evidence sufficiency verification before network dispatch
    for (const [key, qSpec] of Object.entries(request.questions)) {
      const sufficiency = checkEvidenceSufficiency(qSpec, availableEvidence);
      if (!sufficiency.sufficient) {
        answers[key] = {
          questionId: qSpec.id,
          questionVersion: qSpec.version,
          type: qSpec.type,
          model,
          provider,
          status: "abstain_insufficient_evidence",
          answer: false,
          probability: 0.0,
          confidence: 0.0,
          evidenceRefs: inputEvidenceRefs,
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
      memoryDecisionCache.set(inputHash, response);
      return response;
    }

    // If API key is not configured, abstain with explicit reason (no faking, no LLM chat fallback)
    if (!this.config.apiKey) {
      for (const [key, qSpec] of Object.entries(questionsToDispatch)) {
        answers[key] = {
          questionId: qSpec.id,
          questionVersion: qSpec.version,
          type: qSpec.type,
          model,
          provider,
          status: "abstain_uncertain",
          answer: false,
          probability: 0.0,
          confidence: 0.0,
          evidenceRefs: inputEvidenceRefs,
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

    // Execute remote TypeSafe JEV call via OpenRouter Decisions API (POST /decisions)
    try {
      const url = `${this.config.baseUrl}/decisions`;
      const payload = {
        model,
        state: cleanState,
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
        throw new Error(`OpenRouter Decisions API returned status ${res.status}: ${await res.text()}`);
      }

      const data = (await res.json()) as {
        answers?: Record<string, any>;
        decisions?: Record<string, any>;
      };

      const remoteAnswers = data.answers || data.decisions || {};

      for (const [key, qSpec] of Object.entries(questionsToDispatch)) {
        const item = remoteAnswers[key];
        if (item) {
          // Normalize according to question type: noul, choice, score
          if (qSpec.type === "noul" || item.type === "noul") {
            const rawProb = typeof item.noul === "number"
              ? item.noul
              : (typeof item.probability === "number" ? item.probability : undefined);

            if (rawProb === undefined || Number.isNaN(rawProb) || rawProb < 0 || rawProb > 1) {
              answers[key] = {
                questionId: qSpec.id,
                questionVersion: qSpec.version,
                type: "noul",
                model,
                provider,
                status: "provider_error",
                evidenceRefs: inputEvidenceRefs,
                abstainReason: "Remote JEV response returned invalid or missing noul probability.",
                evaluatedAt: new Date().toISOString(),
              };
              continue;
            }

            answers[key] = {
              questionId: qSpec.id,
              questionVersion: qSpec.version,
              type: "noul",
              model,
              provider,
              status: "answered",
              noul: rawProb,
              probability: rawProb,
              answer: rawProb >= 0.5,
              confidence: undefined, // noul probability is returned directly; confidence is not fabricated
              evidenceRefs: inputEvidenceRefs,
              evaluatedAt: new Date().toISOString(),
            };
          } else if (qSpec.type === "choice" || item.type === "choice") {
            const rawChoice = typeof item.choice === "string" ? item.choice : (typeof item.answer === "string" ? item.answer : undefined);
            if (!rawChoice) {
              answers[key] = {
                questionId: qSpec.id,
                questionVersion: qSpec.version,
                type: "choice",
                model,
                provider,
                status: "provider_error",
                evidenceRefs: inputEvidenceRefs,
                abstainReason: "Remote JEV response returned missing or empty choice string.",
                evaluatedAt: new Date().toISOString(),
              };
              continue;
            }

            const conf = typeof item.confidence === "number" ? item.confidence : undefined;
            const probs = item.probabilities || item.distribution;

            answers[key] = {
              questionId: qSpec.id,
              questionVersion: qSpec.version,
              type: "choice",
              model,
              provider,
              status: "answered",
              choice: rawChoice,
              answer: rawChoice,
              probabilities: probs,
              distribution: probs,
              confidence: conf,
              evidenceRefs: inputEvidenceRefs,
              evaluatedAt: new Date().toISOString(),
            };
          } else if (qSpec.type === "score" || item.type === "score") {
            const rawScore = typeof item.score === "number" ? item.score : (typeof item.answer === "number" ? item.answer : undefined);
            if (rawScore === undefined || Number.isNaN(rawScore)) {
              answers[key] = {
                questionId: qSpec.id,
                questionVersion: qSpec.version,
                type: "score",
                model,
                provider,
                status: "provider_error",
                evidenceRefs: inputEvidenceRefs,
                abstainReason: "Remote JEV response returned missing or invalid numeric score.",
                evaluatedAt: new Date().toISOString(),
              };
              continue;
            }

            const conf = typeof item.confidence === "number" ? item.confidence : undefined;
            const probs = item.probabilities || item.distribution;

            answers[key] = {
              questionId: qSpec.id,
              questionVersion: qSpec.version,
              type: "score",
              model,
              provider,
              status: "answered",
              score: rawScore,
              answer: rawScore,
              probabilities: probs,
              distribution: probs,
              confidence: conf,
              legend: item.legend,
              evidenceRefs: inputEvidenceRefs,
              evaluatedAt: new Date().toISOString(),
            };
          } else {
            // General typed answer
            if (item.answer === undefined && item.choice === undefined && item.score === undefined) {
              answers[key] = {
                questionId: qSpec.id,
                questionVersion: qSpec.version,
                type: qSpec.type,
                model,
                provider,
                status: "provider_error",
                evidenceRefs: inputEvidenceRefs,
                abstainReason: "Remote JEV response missing answer field.",
                evaluatedAt: new Date().toISOString(),
              };
              continue;
            }

            answers[key] = {
              questionId: qSpec.id,
              questionVersion: qSpec.version,
              type: qSpec.type,
              model,
              provider,
              status: "answered",
              answer: item.answer ?? item.choice ?? item.score,
              probability: typeof item.probability === "number" ? item.probability : undefined,
              confidence: typeof item.confidence === "number" ? item.confidence : undefined,
              evidenceRefs: inputEvidenceRefs,
              evaluatedAt: new Date().toISOString(),
            };
          }
        } else {
          answers[key] = {
            questionId: qSpec.id,
            questionVersion: qSpec.version,
            type: qSpec.type,
            model,
            provider,
            status: "abstain_uncertain",
            evidenceRefs: inputEvidenceRefs,
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
          type: qSpec.type,
          model,
          provider,
          status: "abstain_uncertain",
          answer: false,
          confidence: 0.0,
          evidenceRefs: inputEvidenceRefs,
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

    memoryDecisionCache.set(inputHash, response);

    // Persist to DB ledger if SQL client is configured
    if (this.sql) {
      try {
        await this.sql`
          insert into jev_runs (
            id, organization_id, brand_id, question_set, model, provider, input_hash, status, metadata
          ) values (
            ${runId}, ${request.organizationId}, ${request.brandId}, 'default',
            ${model}, ${provider}, ${inputHash}, 'completed',
            ${JSON.stringify({ latencyMs: response.latencyMs, questionCount: Object.keys(answers).length })}
          )
          on conflict (id) do nothing
        `;

        for (const ans of Object.values(answers)) {
          await this.sql`
            insert into jev_answers (
              id, organization_id, brand_id, run_id, record_id, question_id, question_version,
              model, provider, answer, probability, distribution, confidence, status, evidence
            ) values (
              ${globalThis.crypto.randomUUID()}, ${request.organizationId}, ${request.brandId}, ${runId},
              ${ans.questionId}, ${ans.questionId}, ${ans.questionVersion},
              ${ans.model}, ${ans.provider}, ${JSON.stringify(ans.answer)},
              ${ans.probability ?? null}, ${JSON.stringify(ans.probabilities || ans.distribution || {})},
              ${ans.confidence ?? 0.0}, ${ans.status}, ${JSON.stringify(ans.evidenceRefs)}
            )
          `;
        }
      } catch {
        // Non-fatal if DB is offline or running in mock environment
      }
    }

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
        content: input.evidenceBundle.content,
        performance: input.evidenceBundle.performance,
        evidenceRefs: [{ field: "metadata", artifactId: input.evidenceBundle.id }],
      },
      questions: {
        [input.question.id]: input.question,
      },
    });

    return (
      resp.answers[input.question.id] || {
        questionId: input.question.id,
        questionVersion: input.question.version,
        type: input.question.type,
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
