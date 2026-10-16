// The final Critic for one rendered video (Bible 6.12, 12.3): runs critic_final through runRole on the request's budget. Haiku answers
// first. When Haiku's confidence is below thresholds.postRender.sonnetRecheckBelow, the same input goes to Sonnet (the re-check), and
// Sonnet's answer is the outcome. Every call is authorized and reconciled on the reservation, so the ledger holds the money.
//
// A frame set that does not match the role's contract, a refused call, a duplicate call and a re-check with no answer are all
// not_answered: missing evidence that routes to review (Bible 12). Only an answer that fails its contract twice throws
// (RoleAnswerError), so the stage fails and the job retries it.

import type { BudgetAlert } from "../budget/reserve.ts";
import { thresholds } from "../config/thresholds.ts";
import { runRole, type RoleCall, type RoleDeps, type RoleOutcome } from "../claude/client.ts";
import { criticFinal, criticFinalInputSchema, criticFinalRecheck, type CriticFinalInput, type FinalRubricItem } from "../claude/roles/critic_final.ts";

export type CriticFinalOutcome =
  | {
      status: "answered";
      rubric: Record<FinalRubricItem, number>;
      confidence: number;
      /** Which model's answer this is: Haiku's, or Sonnet's when the re-check ran. */
      answeredBy: "haiku" | "sonnet";
    }
  | { status: "not_answered"; reason: string };

export type CriticFinalRequest = {
  requestId: string;
  workspaceId: string;
  reservationId: string;
  /** The job's infrastructure attempt (Bible 5.1), from 1. */
  attempt?: number;
  signal?: AbortSignal;
  /** The critic_final input: the video, its duration, the EDL summary and the twelve frames. Parsed here; a bad input is not_answered. */
  input: unknown;
};

export type CriticFinalRun = {
  outcome: CriticFinalOutcome;
  /** True when Haiku was unsure and the Sonnet re-check ran (Bible 12.3). */
  rechecked: boolean;
  /** Every paid call of this run, for the manifest. */
  calls: RoleCall[];
  alerts: BudgetAlert[];
};

function invalidInput(input: unknown): string {
  const parsed = criticFinalInputSchema.safeParse(input);
  if (parsed.success) return "";
  return parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "input"}: ${issue.code}`)
    .join("; ");
}

/** Runs the final Critic on one video. Never throws for a bad frame set or a refused or duplicate call; throws for a broken answer. */
export async function runCriticFinal(deps: RoleDeps, request: CriticFinalRequest): Promise<CriticFinalRun> {
  const parsed = criticFinalInputSchema.safeParse(request.input);
  if (!parsed.success) {
    return {
      outcome: { status: "not_answered", reason: `the rendered frames do not match the final Critic contract (${invalidInput(request.input)})` },
      rechecked: false,
      calls: [],
      alerts: [],
    };
  }
  const input: CriticFinalInput = parsed.data;
  const common = {
    requestId: request.requestId,
    workspaceId: request.workspaceId,
    reservationId: request.reservationId,
    attempt: request.attempt,
    signal: request.signal,
    input,
  };

  const first = await runRole(deps, criticFinal, common);
  if (first.status !== "done") {
    return { outcome: { status: "not_answered", reason: unanswered("the final Critic call", first) }, rechecked: false, calls: first.calls, alerts: first.alerts };
  }
  const haiku = first.value;
  if (haiku.confidence >= thresholds.postRender.sonnetRecheckBelow) {
    return {
      outcome: { status: "answered", rubric: { ...haiku.rubric }, confidence: haiku.confidence, answeredBy: "haiku" },
      rechecked: false,
      calls: first.calls,
      alerts: first.alerts,
    };
  }

  // Haiku is unsure (Bible 12.3): the same input goes to Sonnet, and its answer decides.
  const second = await runRole(deps, criticFinalRecheck, common);
  const calls = [...first.calls, ...second.calls];
  const alerts = [...first.alerts, ...second.alerts];
  if (second.status !== "done") {
    return {
      outcome: { status: "not_answered", reason: unanswered("the Sonnet re-check", second) },
      rechecked: true,
      calls,
      alerts,
    };
  }
  return {
    outcome: { status: "answered", rubric: { ...second.value.rubric }, confidence: second.value.confidence, answeredBy: "sonnet" },
    rechecked: true,
    calls,
    alerts,
  };
}

/** Why a call gave no answer, in words the review item can show. Only the role's own reason text is quoted, never model prose. */
function unanswered(what: string, outcome: RoleOutcome<unknown>): string {
  if (outcome.status === "refused") return `${what} was refused: ${outcome.reason}`;
  if (outcome.status === "duplicate") return `${what} was already authorized, and its answer is not held in this run`;
  return `${what} gave no answer`;
}
