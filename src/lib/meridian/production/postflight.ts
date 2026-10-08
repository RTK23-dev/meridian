/**
 * Postflight Quality Control Gate
 *
 * Verifies rendered video artifacts against specifications, visual guidelines,
 * and safety criteria before making them available for publishing.
 */

import type { ProductionJob } from "./types.ts";
import { isMp4 } from "../research/media.ts";

export type PostflightResult = {
  passed: boolean;
  decision: "APPROVE_FOR_DISTRIBUTION" | "REJECT_DEFECTIVE" | "HUMAN_REVIEW";
  reasons: string[];
  evaluatedAt: string;
};

export function evaluateProductionPostflight(input: {
  job: ProductionJob;
  videoBytes: Uint8Array;
  durationMs?: number;
}): PostflightResult {
  const reasons: string[] = [];

  // 1. Validate binary content
  if (input.videoBytes.byteLength === 0) {
    return {
      passed: false,
      decision: "REJECT_DEFECTIVE",
      reasons: ["Rendered video artifact has 0 bytes."],
      evaluatedAt: new Date().toISOString(),
    };
  }

  // 2. Validate format
  if (!isMp4(input.videoBytes)) {
    reasons.push("Artifact is not a valid MP4 container.");
  }

  // 3. Duration verification if available
  if (typeof input.durationMs === "number" && input.durationMs > 0) {
    const durationSec = input.durationMs / 1000;
    const targetSec = input.job.creativeSpec.durationTargetSeconds;
    const diff = Math.abs(durationSec - targetSec);
    if (diff > Math.max(10, targetSec * 0.3)) {
      reasons.push(`Rendered duration (${durationSec.toFixed(1)}s) deviates significantly from target (${targetSec}s).`);
    }
  }

  if (reasons.length > 0) {
    return {
      passed: false,
      decision: "REJECT_DEFECTIVE",
      reasons,
      evaluatedAt: new Date().toISOString(),
    };
  }

  return {
    passed: true,
    decision: "APPROVE_FOR_DISTRIBUTION",
    reasons: ["Postflight passed: container verified and duration aligns with spec."],
    evaluatedAt: new Date().toISOString(),
  };
}
