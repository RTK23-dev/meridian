/**
 * The four Stepper steps and their states, read from the stored session. Pure: the states come from the stored briefs,
 * recommendation and variants, and nothing is assumed about a step that has no stored data.
 */

import type { StepState } from "@/components/ui";
import type { StudioBrief, StudioData } from "./types.ts";

export type StudioStep = { label: string; state: StepState; description: string };

export function studioStepperSteps(session: StudioData, brief: StudioBrief | null): StudioStep[] {
  const recommendation = session.recommendation;
  return [
    {
      label: "Direction",
      state: recommendation ? "done" : "current",
      description: recommendation ? "Evidence-backed opportunity" : "Waiting for evidence",
    },
    {
      label: "Brief",
      state: brief?.status === "ready" ? "done" : recommendation ? "current" : "upcoming",
      description: brief?.status === "ready" ? "Approved for production" : "JEV decision to brief",
    },
    {
      label: "Generate",
      state: session.variants.length ? "done" : brief?.status === "ready" ? "current" : "upcoming",
      description: `${session.variants.length} stored variants`,
    },
    {
      label: "Review",
      state: session.variants.some((variant) => variant.reviewStatus === "open" || variant.creativeStatus === "in_review")
        ? "current"
        : session.variants.length ? "done" : "upcoming",
      description: `${session.variants.filter((variant) => variant.creativeStatus === "in_review").length} awaiting review`,
    },
  ];
}
