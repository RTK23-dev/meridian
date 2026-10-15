// Step 5 of the visual decision engine (Bible 7.7, 6.4 step 6): the director check of the whole plan. The director (Opus, one call)
// proposes swaps and prompt edits. This file applies them under the rules, and ignores and logs whatever breaks a rule:
//   - a swap moves a shot to one of its own filtered candidates (7.2), and the plan still fits the request budget;
//   - a prompt edit changes a generated shot's prompt, and the new prompt asks for no rendered text (L8).
// applyDirectorCheck is pure. runDirectorCheck makes the one role call through the Claude client.

import type { BudgetAlert } from "../budget/reserve.ts";
import { runRole, type RoleCall, type RoleDeps } from "../claude/client.ts";
import { VISUAL_TYPES, type BeatRole, type Decision, type VisualType } from "../contracts/index.ts";
import {
  directorCheck,
  type DirectorCheckAnswer,
  type DirectorCheckInput,
} from "../claude/roles/director_check.ts";
import { promptAsksForText } from "../review/gates/promptText.ts";
import { planTotals, usdAtMost } from "./cost.ts";
import type { ShotCandidate } from "./visual.ts";

/** One shot as the director step sees it: its current choice, its candidates, and its prompt (the planner's, until edited). */
export type DirectorChoice = {
  shotId: string;
  beatRole: BeatRole;
  durationMs: number;
  showsProduct: boolean;
  mustSatisfy: string | null;
  /**
   * The script's text of the shot's beat, shown to the director as untrusted data (Bible 7.7). Only the director sees it: the
   * planner's prompts never carry script text (L8), and a prompt edit that asks for text is still ignored below.
   */
  beatText?: string;
  visualType: VisualType;
  generated: boolean;
  baseUsd: number;
  score: number;
  /** Every candidate that survived the filter, with its cost and score (ShotChoice.candidates). A swap stays inside this list. */
  candidates: readonly ShotCandidate[];
  /** The generation prompt, when the shot is generated and has one. */
  prompt: string | null;
};

export type DirectorOutcome = {
  choices: DirectorChoice[];
  /** One Decision per swap applied, per swap ignored, per prompt edit applied or ignored, and one for the approval. */
  decisions: Decision[];
  ok: boolean;
  swapsApplied: number;
  swapsIgnored: number;
  editsApplied: number;
  editsIgnored: number;
};

function isVisualType(value: string): value is VisualType {
  return (VISUAL_TYPES as readonly string[]).includes(value);
}

function reservedOf(choices: readonly DirectorChoice[]): number {
  return planTotals(choices.map((choice) => ({ baseUsd: choice.baseUsd, generated: choice.generated }))).reservedUsd;
}

/**
 * Apply the director's answer (7.7). Swaps are applied in order, each checked against the choices made so far, so a later swap
 * sees the budget the earlier ones left. Every refusal is a Decision with its reason, and the plan's choices are unchanged by it.
 * The reasons are written here, from the rule that broke, never from the model's text.
 */
export function applyDirectorCheck(input: {
  choices: readonly DirectorChoice[];
  requestBudgetUsd: number;
  answer: DirectorCheckAnswer;
}): DirectorOutcome {
  let current: DirectorChoice[] = input.choices.map((choice) => ({ ...choice }));
  const decisions: Decision[] = [];
  let swapsApplied = 0;
  let swapsIgnored = 0;
  let editsApplied = 0;
  let editsIgnored = 0;

  const ignoreSwap = (at: string, reason: string): void => {
    swapsIgnored += 1;
    decisions.push({ at, chose: "unchanged", alternatives: [], reason: `Director swap ignored: ${reason}.`, by: "director" });
  };

  for (const swap of input.answer.swaps) {
    const index = current.findIndex((choice) => choice.shotId === swap.shotId);
    if (index < 0) {
      ignoreSwap("plan", "the shot is not in this plan");
      continue;
    }
    const shot = current[index];
    if (!isVisualType(swap.toType)) {
      ignoreSwap(shot.shotId, "the named type is not a visual type");
      continue;
    }
    if (swap.toType === shot.visualType) {
      ignoreSwap(shot.shotId, `the shot is already ${shot.visualType}`);
      continue;
    }
    const candidate = shot.candidates.find((item) => item.visualType === swap.toType);
    if (candidate === undefined) {
      ignoreSwap(shot.shotId, `${swap.toType} is not among the shot's filtered candidates`);
      continue;
    }
    const trial = current.map((choice, position) =>
      position === index
        ? { ...choice, visualType: candidate.visualType, generated: candidate.generated, baseUsd: candidate.baseUsd, score: candidate.score }
        : choice,
    );
    if (!usdAtMost(reservedOf(trial), input.requestBudgetUsd)) {
      ignoreSwap(shot.shotId, `${swap.toType} would take the plan over the request budget`);
      continue;
    }
    current = trial;
    swapsApplied += 1;
    decisions.push({
      at: shot.shotId,
      chose: candidate.visualType,
      alternatives: [{ option: shot.visualType, score: shot.score }],
      reason: `Director swap: ${candidate.visualType} is among the shot's filtered candidates and the plan still fits the request budget.`,
      by: "director",
    });
  }

  for (const edit of input.answer.promptEdits) {
    const index = current.findIndex((choice) => choice.shotId === edit.shotId);
    const ignoreEdit = (at: string, reason: string): void => {
      editsIgnored += 1;
      decisions.push({ at, chose: "prompt unchanged", alternatives: [], reason: `Director prompt edit ignored: ${reason}.`, by: "director" });
    };
    if (index < 0) {
      ignoreEdit("plan", "the shot is not in this plan");
      continue;
    }
    const shot = current[index];
    if (!shot.generated) {
      ignoreEdit(shot.shotId, "the shot is not generated, so it has no prompt");
      continue;
    }
    if (promptAsksForText(edit.prompt).asksForText) {
      ignoreEdit(shot.shotId, "the prompt asks for text, a sign, a logo, a caption or a price to be drawn");
      continue;
    }
    current[index] = { ...shot, prompt: edit.prompt };
    editsApplied += 1;
    decisions.push({
      at: shot.shotId,
      chose: "prompt edited",
      alternatives: [],
      reason: "Director prompt edit applied: the shot is generated and the new prompt asks for no rendered text.",
      by: "director",
    });
  }

  const ok = input.answer.ok;
  decisions.push({
    at: "plan",
    chose: ok ? "approved" : "not approved",
    alternatives: [],
    reason: ok
      ? "The director approved the plan as it stands."
      : "The director did not approve the plan. The plan gate still decides what may be produced.",
    by: "director",
  });

  return { choices: current, decisions, ok, swapsApplied, swapsIgnored, editsApplied, editsIgnored };
}

export type DirectorRun =
  | { status: "answered"; answer: DirectorCheckAnswer; calls: RoleCall[]; alerts: BudgetAlert[] }
  | { status: "not_answered"; reason: string; calls: RoleCall[]; alerts: BudgetAlert[] };

export type DirectorRunInput = {
  requestId: string;
  workspaceId: string;
  reservationId: string;
  attempt?: number;
  signal?: AbortSignal;
  input: DirectorCheckInput;
};

/** The one director call of a plan (Bible 7.7). A refused or duplicate call is not_answered: the plan then fails its gate. */
export async function runDirectorCheck(deps: RoleDeps, request: DirectorRunInput): Promise<DirectorRun> {
  const run = await runRole(deps, directorCheck, {
    requestId: request.requestId,
    workspaceId: request.workspaceId,
    reservationId: request.reservationId,
    attempt: request.attempt,
    signal: request.signal,
    input: request.input,
  });
  if (run.status === "done") {
    return { status: "answered", answer: run.value, calls: run.calls, alerts: run.alerts };
  }
  if (run.status === "refused") {
    return { status: "not_answered", reason: `the director call was refused: ${run.reason}`, calls: run.calls, alerts: run.alerts };
  }
  return {
    status: "not_answered",
    reason: "this director call was already authorized, and its answer is not held in this run",
    calls: run.calls,
    alerts: run.alerts,
  };
}
