/**
 * The lines the Factory run view shows for a pick's grade, its status and its variants (NORTH_STAR section 8, item 11). Pure: the route
 * passes the values it loaded. A grade the engine did not give reads "not graded", never a score. A variant names the one attribute it
 * tests, against its control.
 */

import type { PredictionStatus, PredictionView } from "@/lib/meridian/factory/prediction";

const ACTION_WORDS: Record<string, string> = { AUTO_APPROVE: "approve", HUMAN_REVIEW: "review", REJECT: "reject" };

/** A grade in plain words: the engine's answer and what it was asked with, or why there is none. */
export function predictionText(view: PredictionView): string {
  if (view.state === "engine") {
    const answer = ACTION_WORDS[view.action] ?? view.action;
    const engine = view.model ? `${view.engineId} (${view.model})` : view.engineId;
    const questions = view.questionVersions.length > 0 ? `, asked ${view.questionVersions.join(", ")}` : "";
    return `Engine answer: ${answer}, from ${engine}${questions}.`;
  }
  if (view.state === "observed_only") return `Not graded: ${view.reason}`;
  return "Not graded.";
}

/** Whether the grade shown is the one the pick was made under. */
export function predictionStatusText(status: PredictionStatus): string {
  if (status === "same") return "This is the prediction the pick was made under.";
  if (status === "regraded") {
    return "The ad was graded again after this pick. The grade the pick was made under is not kept, so the grade shown is the current one.";
  }
  return "No grade was stored with this pick, so the prediction it was made under is not known.";
}

/** The plan's status for a pick: planned, not planned with the reason, or no storyboard yet. */
export function planText(plan: "planned" | "not_planned" | "no_storyboard", reason: string): string {
  if (plan === "planned") return "Planned: a creative plan is stored for this pick.";
  if (plan === "not_planned") return `Not planned: ${reason}`;
  return reason;
}

export type VariantFields = {
  attribute: string;
  hook: string;
  angle: string;
  format: string;
  proof: string;
  cta: string;
  gateResult: string;
};

const ATTRIBUTE_LABELS: Record<string, string> = {
  hook: "Tests the hook",
  angle: "Tests the angle",
  format: "Tests the format",
  proof: "Tests the proof",
  cta: "Tests the call to action",
};

/** The variant's heading: the attribute it tests and the value it sets, or the control's values. */
export function variantHeading(variant: VariantFields): string {
  if (variant.attribute === "control") {
    const values = [variant.hook, variant.angle, variant.format, variant.proof, variant.cta].filter((value) => value !== "");
    return values.length > 0 ? `Control: ${values.join(" · ")}` : "Control";
  }
  const label = ATTRIBUTE_LABELS[variant.attribute];
  if (!label) return "Attribute not recorded";
  const value = {
    hook: variant.hook,
    angle: variant.angle,
    format: variant.format,
    proof: variant.proof,
    cta: variant.cta,
  }[variant.attribute as "hook" | "angle" | "format" | "proof" | "cta"] ?? "";
  return value ? `${label}: ${value}` : label;
}

/** The gate's result for a variant, as stored. A variant the gate has not judged reads review. */
export function gateText(gateResult: string): string {
  return `Gate: ${gateResult || "review"}`;
}
