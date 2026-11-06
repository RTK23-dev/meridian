// The live model port of the direction pipeline (INTEGRATION.md, step 2). Every call goes through Meridian's generation path
// (providers/chat.server.ts, completeWithModel): the workspace's own OpenRouter key through the credential resolver, the call bounded from
// the model's listed prices and refused above the per-call ceiling or the monthly budget, a budget hold written before the request and
// settled with the cost OpenRouter reports. A call whose outcome is unknown stays an uncertain hold, and is reported to the pipeline as a
// failure, never retried here.
//
// Slots name model seats. The caller maps each slot to a model the workspace chose from the live catalogue (AGENTS.md rule 5: an explicit
// choice, or Auto resolved by the caller, seats.ts); a slot with no model is refused, never filled with a guess. The direction jobs
// (service.ts) use this port; a run spends money, so it starts only when an admin asks for scripts.

import type { TextModelChoice } from "../../../engine/orchestrator/settings.ts";
import { completeWithModel, type GenerationResult } from "../providers/chat.server.ts";
import type { Sql } from "../learning/store.ts";
import type { DirectionPort, ModelCall, ModelReply } from "./pipeline.ts";

/** The model of one slot, as the live catalogue lists it. */
export type SlotModel = { model: string; choice: TextModelChoice };

export type LiveDirectionContext = {
  organizationId: string;
  brandId: string | null;
  sql: Sql;
  /** One id for the whole run, so every call's hold and ledger row can be found together. */
  correlationId: string;
  /** What the run was made from, for the ledger (for example the draft session id). */
  inputRef: string;
  slots: Record<string, SlotModel>;
};

/** How long one direction call may take. */
export const DIRECTION_CALL_TIMEOUT_MS = 120_000;

type Complete = typeof completeWithModel;

/** The port for one run. `complete` is the generation call; tests pass a fake. */
export function liveDirectionPort(context: LiveDirectionContext, complete: Complete = completeWithModel): DirectionPort {
  return {
    async complete(call: ModelCall): Promise<ModelReply> {
      const slot = context.slots[call.slot];
      if (!slot) return { ok: false, error: `No model is chosen for the "${call.slot}" slot, so nothing was sent.`, billed: "no" };
      const [promptId, promptVersion] = call.promptId.split("@") as [string, string | undefined];
      const result: GenerationResult = await complete(context.organizationId, {
        system: call.system,
        user: call.user,
        maxTokens: call.maxTokens,
        temperature: call.temperature,
        timeoutMs: DIRECTION_CALL_TIMEOUT_MS,
        model: slot.model,
        modelSource: "workspace",
        choice: slot.choice,
        record: {
          sql: context.sql,
          brandId: context.brandId,
          correlationId: context.correlationId,
          operation: `direction.${call.step}`,
          promptId,
          promptVersion: promptVersion ?? "",
          inputRef: context.inputRef,
        },
      });
      // "unavailable" and "failed" mean nothing was billed (nothing sent, or the provider was not connected); "uncertain" may have been.
      if (!result.ok) return { ok: false, error: `${result.status}: ${result.error}`, billed: result.status === "uncertain" ? "unknown" : "no" };
      return { ok: true, content: result.content, model: result.returnedModel ?? result.model, costUsd: result.costUsd };
    },
  };
}
