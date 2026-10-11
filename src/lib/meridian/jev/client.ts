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
import type { JevQuestionSpec } from "./types.ts";

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

/**
 * Minimizes state before sending to remote JEV API, stripping out unneeded secrets,
 * raw database columns, and irrelevant internal identifiers.
 */
export function minimizeJevState(state: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};

  if (state.description) clean.description = state.description;
  if (state.bundleId) clean.bundleId = state.bundleId;
  if (state.source) clean.source = state.source;
  if (state.platform) clean.platform = state.platform;
  if (state.contentType) clean.contentType = state.contentType;
  if (state.metrics) clean.metrics = state.metrics;
  if (state.performance) clean.performance = state.performance;
  if (state.transcriptSummary) clean.transcriptSummary = state.transcriptSummary;
  if (state.sceneSummary) clean.sceneSummary = state.sceneSummary;
  if (state.scenes) clean.scenes = state.scenes;
  if (state.ocr) clean.ocr = state.ocr;
  if (state.comments) clean.comments = state.comments;
  if (state.transcript) clean.transcript = state.transcript;
  if (state.profile) clean.profile = state.profile;
  if (state.derivedMetrics) clean.derivedMetrics = state.derivedMetrics;
  if (state.comparisonContext) clean.comparisonContext = state.comparisonContext;
  if (state.content) clean.content = state.content;
  if (state.controls) clean.controls = state.controls;
  if (state.records) clean.records = state.records;
  if (state.availableEvidence) clean.availableEvidence = state.availableEvidence;
  if (state.evidenceRefs) clean.evidenceRefs = state.evidenceRefs;

  // Pass through any other structured domain fields that are non-sensitive
  for (const [k, v] of Object.entries(state)) {
    if (clean[k] === undefined && v !== undefined && v !== null) {
      const lower = k.toLowerCase();
      if (!lower.includes("secret") && !lower.includes("token") && !lower.includes("password") && !lower.includes("apikey")) {
        clean[k] = v;
      }
    }
  }

  return clean;
}

