// The cookbook selector's port (round 3, K10; decision Q34): the model call behind the selector, made through the engine's role runner, so
// the call is budgeted, recorded and retried like every other role. A call needs a production request and its budget reservation to be made
// against (client.ts). Where there is none, the caller passes no port, and the selector stays on the picker (proposeCookbooks: not_connected).
// Server-side only: it imports the engine's client.

import { runRole, type RoleDeps, type RoleOutcome } from "../../../engine/claude/client.ts";
import { EngineError } from "../../../engine/contracts/errors.ts";
import { cookbookSelector, type CookbookSelectorAnswer } from "../../../engine/claude/roles/cookbook_selector.ts";
import type { SelectorPort } from "./selector.ts";

/** Where the call is made: the role's dependencies, and the request and reservation it is budgeted against. */
export type SelectorScope = {
  deps: RoleDeps;
  requestId: string;
  workspaceId: string;
  reservationId: string;
  attempt?: number;
  signal?: AbortSignal;
};

/**
 * The port for one request. A stored answer is reused by the role runner (no second paid call). A refused call, a duplicate and a failed
 * answer are all reported as failed, never as a pick. A provider that is not connected is reported as not_connected.
 */
export function cookbookSelectorPort(scope: SelectorScope): SelectorPort {
  return async ({ input }) => {
    try {
      const outcome: RoleOutcome<CookbookSelectorAnswer> = await runRole(scope.deps, cookbookSelector, {
        requestId: scope.requestId,
        workspaceId: scope.workspaceId,
        reservationId: scope.reservationId,
        attempt: scope.attempt,
        signal: scope.signal,
        input,
      });
      if (outcome.status === "done") return { ok: true, text: JSON.stringify(outcome.value) };
      if (outcome.status === "refused") {
        return { ok: false, reason: "failed", message: `the cookbook selector call was refused: ${outcome.reason}` };
      }
      return { ok: false, reason: "failed", message: "an earlier cookbook selector call for this request has no stored answer, so it is not asked again" };
    } catch (error) {
      if (error instanceof EngineError && error.kind === "config") {
        return { ok: false, reason: "not_connected", message: "The cookbook selector is not connected. Pick a cookbook." };
      }
      return { ok: false, reason: "failed", message: error instanceof Error ? error.message : "the cookbook selector call failed" };
    }
  };
}
