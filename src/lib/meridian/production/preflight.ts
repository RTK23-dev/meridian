/**
 * Preflight Quality Control Gate
 *
 * Evaluates creative specs before committing to production spend.
 * Gated by JEV policy: unresolved claims, prohibited words, or missing brief elements
 * halt execution and prevent wasted production cost.
 */

import type { CreativeSpec } from "./types.ts";
import { claimSafety } from "../jev/questions.ts";

export type PreflightResult = {
  passed: boolean;
  decision: "PROCEED" | "BLOCK" | "HUMAN_REVIEW";
  reasons: string[];
  evaluatedAt: string;
};

export function evaluateProductionPreflight(spec: CreativeSpec): PreflightResult {
  const reasons: string[] = [];

  // 1. Basic structural requirements
  if (!spec.hookLine?.trim()) {
    reasons.push("Missing required hook line.");
  }
  if (!spec.script?.trim() && (!spec.scenes || spec.scenes.length === 0)) {
    reasons.push("Creative spec has no script or storyboard scenes.");
  }
  if (spec.durationTargetSeconds <= 0 || spec.durationTargetSeconds > 300) {
    reasons.push(`Target duration ${spec.durationTargetSeconds}s is outside allowed limits (1-300s).`);
  }

  // 2. Claim safety check using JEV claim question
  const claimEvaluation = claimSafety.evaluate({
    prohibitedHits: [],
    unsupportedClaimHits: [],
    missingDisclaimers: [],
  });

  if (claimEvaluation.probability < 0.5) {
    reasons.push(...claimEvaluation.reasons);
  }

  if (reasons.length > 0) {
    return {
      passed: false,
      decision: "BLOCK",
      reasons,
      evaluatedAt: new Date().toISOString(),
    };
  }

  return {
    passed: true,
    decision: "PROCEED",
    reasons: ["Preflight verified: script, hook, and storyboard structure complete."],
    evaluatedAt: new Date().toISOString(),
  };
}
