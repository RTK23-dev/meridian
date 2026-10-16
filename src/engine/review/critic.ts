// The Critic for one take (Bible 6.7 step 3, 12.2): runs the critic_take role through runRole, so the call is authorized and
// reconciled on the request's budget. Its result is an outcome the take gate reads. A frame set that does not match the
// role's contract, a refused call and a duplicate call all give not_answered, which is missing evidence and routes to review.
// Only a role answer that fails its contract twice throws (RoleAnswerError): the stage fails and the job retries it.

import type { BudgetAlert } from "../budget/reserve.ts";
import { thresholds } from "../config/thresholds.ts";
import { runRole, type RoleCall, type RoleDeps } from "../claude/client.ts";
import {
  criticTake,
  criticTakeInputSchema,
  SLOP_RUBRIC_ITEMS,
  type SlopRubricItem,
} from "../claude/roles/critic_take.ts";
import { check, notEvaluated } from "./gates/common.ts";
import type { TakeRow } from "./take/types.ts";

export type CriticOutcome =
  | { status: "answered"; rubric: Record<SlopRubricItem, number>; confidence: number }
  | { status: "not_answered"; reason: string };

export type CriticRequest = {
  requestId: string;
  workspaceId: string;
  reservationId: string;
  /** The job's infrastructure attempt (Bible 5.1), from 1. */
  attempt?: number;
  signal?: AbortSignal;
  /** The critic_take input: shot id, visual type, take duration and the six frames. Parsed here; a bad input is not_answered. */
  input: unknown;
};

export type CriticRun = {
  outcome: CriticOutcome;
  /** Every paid call of this run, for the manifest (RoleCall). */
  calls: RoleCall[];
  alerts: BudgetAlert[];
};

/** Runs the Critic on one take. Never throws for a bad frame set or a refused or duplicate call; throws for a broken answer. */
export async function runCritic(deps: RoleDeps, request: CriticRequest): Promise<CriticRun> {
  const parsed = criticTakeInputSchema.safeParse(request.input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.code}`)
      .join("; ");
    return {
      outcome: { status: "not_answered", reason: `the take's frames do not match the Critic contract (${issues})` },
      calls: [],
      alerts: [],
    };
  }

  const run = await runRole(deps, criticTake, {
    requestId: request.requestId,
    workspaceId: request.workspaceId,
    reservationId: request.reservationId,
    attempt: request.attempt,
    signal: request.signal,
    input: parsed.data,
  });

  if (run.status === "done") {
    return {
      outcome: { status: "answered", rubric: { ...run.value.rubric }, confidence: run.value.confidence },
      calls: run.calls,
      alerts: run.alerts,
    };
  }
  if (run.status === "refused") {
    return { outcome: { status: "not_answered", reason: `the Critic call was refused: ${run.reason}` }, calls: run.calls, alerts: run.alerts };
  }
  // A duplicate key was authorized before, so nothing is called again. The job must reuse the answer it stored; this run has none.
  return {
    outcome: { status: "not_answered", reason: "this Critic call was already authorized, and its answer is not held in this run" },
    calls: run.calls,
    alerts: run.alerts,
  };
}

/**
 * The rows of the Critic's checks (Bible 12.2). Each rubric item is a check of the shared slop-rubric gold set, so a failing
 * item can name its defect in the hints. The Critic's confidence below the escalation threshold is an escalation, not a block.
 */
export function criticRows(outcome: CriticOutcome): TakeRow[] {
  if (outcome.status === "not_answered") {
    return [{ check: notEvaluated("rubric_answered", outcome.reason), evidence: "missing", gold: null }];
  }
  const itemMin = thresholds.take.slopRubricItemMin.value;
  const rows: TakeRow[] = SLOP_RUBRIC_ITEMS.map((item): TakeRow => {
    const score = outcome.rubric[item];
    return {
      check: check(`rubric_${item}`, score >= itemMin, { value: score, limit: itemMin }),
      evidence: "measured",
      gold: "take:slop_rubric",
    };
  });
  const confidenceMin = thresholds.escalation.criticConfidence.value;
  const unsure = outcome.confidence < confidenceMin;
  rows.push({
    check: check("critic_confidence", !unsure, {
      value: outcome.confidence,
      limit: confidenceMin,
      ...(unsure ? { detail: "the Critic is unsure of its rubric, so the take goes to a human" } : {}),
    }),
    evidence: "measured",
    gold: null,
  });
  return rows;
}
