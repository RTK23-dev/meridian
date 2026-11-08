/**
 * The Studio's five phases, in order, and the state each one is in, read from the stored session. The phase dots draw these: a phase that
 * is done, the one waiting on the person, and the ones still ahead. Pure: nothing is assumed about a phase with no stored data.
 */
import type { StepState } from "@/components/ui";
import { studioStepperSteps } from "./stepper-states.ts";
import type { StudioBrief, StudioData } from "./types.ts";

export const STUDIO_PHASES = [
  { key: "direction", label: "Direction" },
  { key: "brief", label: "Brief" },
  { key: "generate", label: "Generate" },
  { key: "review", label: "Review" },
  { key: "queue", label: "Queue" },
] as const;

export type StudioPhaseKey = (typeof STUDIO_PHASES)[number]["key"];

export type StudioPhase = { key: StudioPhaseKey; label: string; state: StepState; description: string };

export function isStudioPhase(value: unknown): value is StudioPhaseKey {
  return typeof value === "string" && STUDIO_PHASES.some((phase) => phase.key === value);
}

export function studioPhases(session: StudioData, brief: StudioBrief | null): StudioPhase[] {
  const [direction, briefStep, generate, review] = studioStepperSteps(session, brief);
  const approved = session.variants.filter((variant) => variant.creativeStatus === "approved").length;
  const published = (session.publications ?? []).length;
  const queue: Omit<StudioPhase, "key" | "label"> = {
    state: published > 0 ? "done" : approved > 0 ? "current" : "upcoming",
    description: published > 0 ? `${published} published` : `${approved} approved to queue`,
  };
  const states = [direction, briefStep, generate, review, queue];
  return STUDIO_PHASES.map((phase, index) => ({ key: phase.key, label: phase.label, state: states[index]!.state, description: states[index]!.description }));
}
