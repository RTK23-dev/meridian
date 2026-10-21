import type { PlanStatus } from "../../engine/orchestrator/store.ts";
import type { StepStatus } from "../progress/step-state.ts";

/** The three steps of Create, in order. Their URLs are /create/brief, /create/<planId>/plan and /create/<planId>/review. */
export const CREATE_STEPS = ["brief", "plan", "review"] as const;

export type CreateStep = (typeof CREATE_STEPS)[number];

/** Plans still being written or run. Brief is done, Plan is current. */
const IN_PLANNING: readonly PlanStatus[] = ["draft", "planning", "refused", "ready", "running"];

/** Plans that have stopped, paused or finished. Brief and Plan are done, Review is current. */
const AFTER_RUN: readonly PlanStatus[] = ["paused", "incomplete", "complete"];

/**
 * The status of each Create step, from the stored plan's status, or null when there is no plan yet. A status this file
 * does not know is treated as no plan, so no step is claimed as done.
 */
export function createStepFor(plan: PlanStatus | null): Record<CreateStep, StepStatus> {
  if (plan !== null && IN_PLANNING.includes(plan)) return { brief: "done", plan: "current", review: "todo" };
  if (plan !== null && AFTER_RUN.includes(plan)) return { brief: "done", plan: "done", review: "current" };
  return { brief: "current", plan: "todo", review: "todo" };
}
