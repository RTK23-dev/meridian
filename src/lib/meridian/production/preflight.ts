/**
 * Preflight Quality Control Gate
 *
 * Checks a creative spec's structure before production spend: the hook, the script or storyboard, and the duration.
 *
 * Claims are not judged here. The spec carries no brand claims, so a claim check run on it would be a check that never looked at
 * the copy. Claims are judged by the copy check (production/assess.ts) and by the shared gate (decisions/gate.ts). This result
 * reports `claimsJudged: false`, so nothing reads it as a claim check that passed.
 */

import type { CreativeSpec } from "./types.ts";

export type PreflightResult = {
  passed: boolean;
  decision: "PROCEED" | "BLOCK" | "HUMAN_REVIEW";
  reasons: string[];
  evaluatedAt: string;
  /** Always false: preflight checks structure, and claims are judged elsewhere. */
  claimsJudged: false;
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

  if (reasons.length > 0) {
    return {
      passed: false,
      decision: "BLOCK",
      reasons,
      evaluatedAt: new Date().toISOString(),
      claimsJudged: false,
    };
  }

  return {
    passed: true,
    decision: "PROCEED",
    reasons: ["Preflight verified: script, hook, and storyboard structure complete."],
    evaluatedAt: new Date().toISOString(),
    claimsJudged: false,
  };
}
