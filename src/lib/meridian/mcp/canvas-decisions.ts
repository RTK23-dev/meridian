// What a person may do to a video project from the canvas, pure so every rule is tested without a database. The canvas never settles a
// step that belongs to the chat: it settles only the person's own checkpoints (in Studio mode, every one but render; in Guided mode, the
// script and the final cut), after the chat has proposed the options, with the option the person picked or their own words. The rules
// that keep the order (workflow.ts, checkpointProblem) are applied again under the project's row lock when the request is stored.

import { CONTENT_MAX, decidesFor, MODE_COPY, PHASE_COPY, PHASES, PROJECT_MODES, type CheckpointRequest, type Phase, type ProjectMode, type ProjectState } from "./workflow.ts";

export const CHOICE_MAX = 200;

export function isPhase(value: unknown): value is Phase {
  return typeof value === "string" && (PHASES as readonly string[]).includes(value);
}

export function isProjectMode(value: unknown): value is ProjectMode {
  return typeof value === "string" && (PROJECT_MODES as readonly string[]).includes(value);
}

export type PersonAnswer = { choice?: string | null; input?: string | null };

/**
 * The checkpoint request for the person's answer on the canvas, or the reason it cannot be sent. The settled text is what the next step
 * builds on: the person's own words when they wrote some, otherwise the option they picked, with its summary.
 */
export function personResolution(
  project: Pick<ProjectState, "mode" | "status" | "checkpoints">,
  phase: Phase,
  answer: PersonAnswer,
): { ok: true; request: CheckpointRequest } | { ok: false; reason: string } {
  const label = PHASE_COPY[phase].label;
  if (project.status !== "active") return { ok: false, reason: `This video is ${project.status}.` };
  if (decidesFor(project.mode, phase) !== "person") {
    return { ok: false, reason: `${label} is settled by the chat in ${MODE_COPY[project.mode].label} mode. Switch to Studio to choose it yourself.` };
  }
  const checkpoint = project.checkpoints[phase];
  if (checkpoint?.status !== "proposed") return { ok: false, reason: `The chat has not offered options for ${label} yet.` };
  const choice = answer.choice?.trim() || null;
  const input = answer.input?.trim() || null;
  if (!choice && !input) return { ok: false, reason: "Pick one of the options, or write your own." };
  if (choice && choice.length > CHOICE_MAX) return { ok: false, reason: "That option name is too long." };
  if (input && input.length > CONTENT_MAX) return { ok: false, reason: `Your own words can be up to ${CONTENT_MAX.toLocaleString("en-US")} characters.` };
  const option = choice ? checkpoint.options.find((item) => item.label === choice) : undefined;
  if (choice && !option) return { ok: false, reason: `'${choice}' is not one of the options offered for ${label}.` };
  const content = input ?? (option ? `${option.label}: ${option.summary}` : null);
  return { ok: true, request: { action: "resolve", phase, decidedBy: "person", choice, input, content } };
}

/** Whether a settled step can be reopened from the canvas: the video is still being made and the step is settled. */
export function reopenProblem(project: Pick<ProjectState, "status" | "checkpoints">, phase: Phase): string | null {
  if (project.status !== "active") return `This video is ${project.status}.`;
  if (project.checkpoints[phase]?.status !== "resolved") return `${PHASE_COPY[phase].label} is not settled, so there is nothing to reopen.`;
  return null;
}

/** The phases a reopen clears: the phase itself and every phase after it that holds anything. */
export function clearedByReopen(project: Pick<ProjectState, "checkpoints">, phase: Phase): Phase[] {
  return PHASES.slice(PHASES.indexOf(phase)).filter((item) => project.checkpoints[item] !== undefined);
}
