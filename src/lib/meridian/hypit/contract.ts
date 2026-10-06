import { createHash } from "node:crypto";
import { assertSameTenant } from "../domain.ts";

/** Meridian's handoff contract. This is not a Hypit source type and not an xAI job. */
export const HYPIT_JOB_SCHEMA = "meridian.hypit.job.v1" as const;

export type HypitEvidenceRef = {
  id: string;
  source: string;
};

export type HypitBrandAsset = {
  id: string;
  role: string;
};

export type HypitDecisionSnapshot = {
  id: string;
  organizationId: string;
  brandId: string;
  questionId: string;
  policyVersion: string;
  decision: "AUTO_APPROVE" | "HUMAN_REVIEW" | "REJECT";
  /** Set only when a person approved a HUMAN_REVIEW decision. */
  reviewerDecision: "approved" | "rejected" | "";
  reasons: string[];
  evidence: { id: string; source: string; summary: string }[];
};

export type HypitHandoffInput = {
  organizationId: string;
  brandId: string;
  product: string;
  objective: string;
  angle: string;
  visualDirection: string;
  tone: string;
  cta: string;
  format: string;
  aspectRatio: string;
  durationSeconds: number;
  requiredClaims: string[];
  prohibitedClaims: string[];
  brandAssets: HypitBrandAsset[];
  briefId: string;
  decision: HypitDecisionSnapshot;
};

export type HypitJobContract = {
  schema: typeof HYPIT_JOB_SCHEMA;
  meridianJobId: string;
  organizationId: string;
  brandId: string;
  product: string;
  objective: string;
  angle: string;
  reasoning: string[];
  evidence: HypitEvidenceRef[];
  requiredClaims: string[];
  prohibitedClaims: string[];
  visualDirection: string;
  tone: string;
  cta: string;
  format: string;
  aspectRatio: string;
  durationSeconds: number;
  brandAssets: HypitBrandAsset[];
  lineage: {
    jevDecisionId: string;
    briefId: string;
    questionId: string;
    policyVersion: string;
  };
};

const ASPECT = /^\d{1,2}:\d{1,2}$/;

function text(value: string): string {
  return value.trim();
}

function approved(decision: HypitDecisionSnapshot): boolean {
  if (decision.decision === "AUTO_APPROVE") return true;
  return decision.decision === "HUMAN_REVIEW" && decision.reviewerDecision === "approved";
}

export function meridianJobId(input: {
  organizationId: string;
  brandId: string;
  jevDecisionId: string;
  briefId: string;
}): string {
  return createHash("sha256")
    .update([input.organizationId, input.brandId, input.jevDecisionId, input.briefId].join("\0"))
    .digest("hex");
}

/**
 * Turns one approved JEV decision and its brief into a Hypit job.
 * A rejected or unapproved decision never becomes a job.
 * Another tenant's decision is refused before any field is copied.
 */
export function buildHypitJob(input: HypitHandoffInput): { ok: true; contract: HypitJobContract } | { ok: false; error: string } {
  assertSameTenant([input.decision], input.organizationId, input.brandId);
  if (!approved(input.decision)) {
    return {
      ok: false,
      error:
        input.decision.decision === "REJECT"
          ? "JEV rejected this creative. No Hypit job was created."
          : "JEV has not approved this creative. No Hypit job was created.",
    };
  }
  const missing: string[] = [];
  const fields: [string, string][] = [
    ["product", input.product],
    ["objective", input.objective],
    ["angle", input.angle],
    ["visual direction", input.visualDirection],
    ["tone", input.tone],
    ["cta", input.cta],
    ["format", input.format],
    ["brief", input.briefId],
    ["decision", input.decision.id],
    ["question", input.decision.questionId],
    ["policy version", input.decision.policyVersion],
  ];
  for (const [label, value] of fields) {
    if (!text(value)) missing.push(label);
  }
  if (!Number.isInteger(input.durationSeconds) || input.durationSeconds < 1 || input.durationSeconds > 60) {
    missing.push("duration");
  }
  if (!ASPECT.test(text(input.aspectRatio))) missing.push("aspect ratio");
  const evidence = input.decision.evidence.filter((item) => text(item.id) && text(item.source));
  const reasoning = input.decision.reasons.map((item) => item.trim()).filter(Boolean);
  if (evidence.length === 0) missing.push("evidence");
  if (reasoning.length === 0) missing.push("reasoning");
  if (missing.length > 0) {
    return { ok: false, error: `Hypit job is missing ${missing.join(", ")}. Nothing was submitted.` };
  }
  const claims = (values: string[]) => values.map((item) => item.trim()).filter(Boolean);
  const assets = input.brandAssets.filter((item) => text(item.id) && text(item.role));
  return {
    ok: true,
    contract: {
      schema: HYPIT_JOB_SCHEMA,
      meridianJobId: meridianJobId({
        organizationId: input.organizationId,
        brandId: input.brandId,
        jevDecisionId: input.decision.id,
        briefId: input.briefId,
      }),
      organizationId: input.organizationId,
      brandId: input.brandId,
      product: text(input.product),
      objective: text(input.objective),
      angle: text(input.angle),
      reasoning,
      evidence: evidence.map((item) => ({ id: text(item.id), source: text(item.source) })),
      requiredClaims: claims(input.requiredClaims),
      prohibitedClaims: claims(input.prohibitedClaims),
      visualDirection: text(input.visualDirection),
      tone: text(input.tone),
      cta: text(input.cta),
      format: text(input.format),
      aspectRatio: text(input.aspectRatio),
      durationSeconds: input.durationSeconds,
      brandAssets: assets.map((item) => ({ id: text(item.id), role: text(item.role) })),
      lineage: {
        jevDecisionId: text(input.decision.id),
        briefId: text(input.briefId),
        questionId: text(input.decision.questionId),
        policyVersion: text(input.decision.policyVersion),
      },
    },
  };
}
