// The request classifier (Bible 7.3): the function intake and the plan stage call to get the properties of every visual request.
// It runs the request_classifier role through the Claude client, so the call is authorized and reconciled against the request's
// budget reservation. A classification that is not returned is never guessed: the outcome says why, and the caller fails the
// `must` checks (missing evidence is review, 12.4). Pure apart from the role call.

import type { BudgetAlert } from "../budget/reserve.ts";
import { runRole, type RoleCall, type RoleDeps } from "../claude/client.ts";
import { requestClassifier, type RequestClassifierInput } from "../claude/roles/request_classifier.ts";
import type { ProductionRequest } from "../contracts/index.ts";
import type { VisualClassification } from "../review/gates/request.ts";
import type { VisualProperty } from "./tables.ts";

/** One visual request of the request, as the classifier reads it (ProductionRequest.visualRequests). */
export type VisualRequestRef = { beatId: string; want: string; strength: "must" | "may" };

/** The visual requests of a production request, in the order the request gives them. */
export function visualRequestsOf(request: ProductionRequest): VisualRequestRef[] {
  return request.visualRequests.map((item) => ({ beatId: item.beatId, want: item.want, strength: item.strength }));
}

export type ClassifyInput = {
  requestId: string;
  workspaceId: string;
  /** The request's budget reservation. The call is made only against it (Bible 14.1). */
  reservationId: string;
  /** The job's infrastructure attempt (Bible 5.1), from 1. */
  attempt?: number;
  signal?: AbortSignal;
  requests: readonly VisualRequestRef[];
};

export type ClassifyOutcome =
  | { status: "classified"; classifications: VisualClassification[]; calls: RoleCall[]; alerts: BudgetAlert[] }
  | { status: "not_classified"; reason: string; calls: RoleCall[]; alerts: BudgetAlert[] };

/**
 * Classify every visual request. An empty list is classified with no call. A refused call (the budget does not cover it) and a
 * duplicate call (authorized before, with no answer held here) are not_classified, with the reason. A role answer that fails its
 * contract twice throws RoleAnswerError: the stage fails, as for every role.
 */
export async function classifyVisualRequests(deps: RoleDeps, input: ClassifyInput): Promise<ClassifyOutcome> {
  if (input.requests.length === 0) {
    return { status: "classified", classifications: [], calls: [], alerts: [] };
  }
  const roleInput: RequestClassifierInput = {
    requests: input.requests.map((item, index) => ({ index, beatId: item.beatId, want: item.want, strength: item.strength })),
  };
  const run = await runRole(deps, requestClassifier, {
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    reservationId: input.reservationId,
    attempt: input.attempt,
    signal: input.signal,
    input: roleInput,
  });

  if (run.status === "done") {
    const byIndex = new Map<number, readonly VisualProperty[]>(
      run.value.classifications.map((item) => [item.index, item.properties]),
    );
    const classifications = input.requests.map((item, index) => ({
      beatId: item.beatId,
      want: item.want,
      properties: [...new Set(byIndex.get(index) ?? [])],
    }));
    return { status: "classified", classifications, calls: run.calls, alerts: run.alerts };
  }
  if (run.status === "refused") {
    return { status: "not_classified", reason: `the classifier call was refused: ${run.reason}`, calls: run.calls, alerts: run.alerts };
  }
  return {
    status: "not_classified",
    reason: "this classifier call was already authorized, and its answer is not held in this run",
    calls: run.calls,
    alerts: run.alerts,
  };
}
