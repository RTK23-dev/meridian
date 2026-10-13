/**
 * Preflight Quality Control Gate
 *
 * Checks a creative spec's structure: the hook, the script or storyboard, and the duration.
 *
 * Status: connected to the video submit path. `submitWithPreflight` (production/submit.ts) runs this check before any provider
 * receives a spec. The Studio video branch (studio/session.server.ts) and the Factory video path (factory/produce-video.ts) submit
 * through it. A BLOCK refuses the spec with these reasons: the job is recorded as PREFLIGHT_FAILED and the provider is not called.
 * A PROCEED continues to the provider.
 *
 * Not connected: the image path. Image specs carry no duration (durationTargetSeconds is 0 for Studio and Factory images), so the
 * duration rule would refuse every image. Connecting images needs a structural rule for images, which is a decision of its own.
 * This check does not exempt images, and it does not fill the missing field.
 *
 * Claims are not judged here. The spec carries no brand claims, so a claim check run on it would be a check that never looked at
 * the copy. Claims are judged by the copy check (production/assess.ts, `judgeCopy`), which the job and studio paths call, and which
 * runs the claim question through the shared engine gate (decisions/gate.ts). This result reports `claimsJudged: false`, so nothing
 * reads it as a claim check that passed.
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
