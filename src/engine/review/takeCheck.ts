// check_take for one take (Bible 6.7): the async steps around the pure take gate. It scores the similarity checks (through the
// scorer interface), runs the Critic (through runRole, on the request's budget), and then calls takeGate. The job handler that
// calls this (eng-pipeline) stores the outcome as the verdict artifact and routes the gate result. The measurements and the
// gold metrics are inputs: this function reads no store and no media function.

import type { BudgetAlert } from "../budget/reserve.ts";
import type { RoleCall, RoleDeps } from "../claude/client.ts";
import { takeFramesSchema, takeShotSchema } from "./take/types.ts";
import type { TakeGoldMetrics, TakeShot } from "./take/types.ts";
import { scoreSimilarity, type SimilarityScorer } from "./take/similarity.ts";
import { runCritic, type CriticOutcome } from "./critic.ts";
import { takeGate, type TakeGateOutcome } from "./gates/take.ts";
import { EngineError } from "../contracts/errors.ts";

export type TakeCheckDeps = {
  /** The Claude client's dependencies: the gateway, the ledger and the clock. */
  role: RoleDeps;
  /** The similarity scorer. The default is notConnectedScorer(), which makes every similarity check missing evidence. */
  scorer: SimilarityScorer;
};

export type TakeCheckRequest = {
  requestId: string;
  workspaceId: string;
  /** The request's budget reservation (res_), which the Critic call is authorized against. */
  reservationId: string;
  attempt?: number;
  signal?: AbortSignal;
  takeId: string;
  /** The take's duration in milliseconds, from the Take artifact. The Critic's frame times must fall inside it. */
  takeDurationMs: number;
  /** The shot the take was made for (see takeShotSchema). */
  shot: unknown;
  /** The take's measurements (see take/code.ts). */
  measurements: unknown;
  /** The six frames of the take, in time order, as data URLs (see takeFramesSchema). */
  frames: unknown;
  /** The style kit's palette (hex colours). Empty when the kit has none, which makes the palette check missing evidence. */
  paletteHex: string[];
  /** Gold-set metrics by key (see gold loader). */
  metrics: TakeGoldMetrics;
};

export type TakeCheckRun = TakeGateOutcome & {
  /** Every paid call of this check, for the manifest. The ledger holds the money. */
  calls: RoleCall[];
  alerts: BudgetAlert[];
  /** The Critic's outcome, kept for the review item. */
  critic: CriticOutcome;
};

/** Runs check_take for one take. Throws invalid_input for a shot that does not parse; every evidence problem is a gate row. */
export async function runTakeCheck(deps: TakeCheckDeps, request: TakeCheckRequest): Promise<TakeCheckRun> {
  const shotParsed = takeShotSchema.safeParse(request.shot);
  if (!shotParsed.success) {
    throw new EngineError("invalid_input", "check_take needs a valid shot from the plan", { stage: "check_take" });
  }
  const shot: TakeShot = shotParsed.data;
  const frames = takeFramesSchema.safeParse(request.frames);

  const similarity = await scoreSimilarity(deps.scorer, {
    takeId: request.takeId,
    frames: frames.success ? frames.data.map((frame) => frame.imageUrl) : null,
    shot,
    paletteHex: request.paletteHex,
  });

  let critic: CriticOutcome;
  let calls: RoleCall[] = [];
  let alerts: BudgetAlert[] = [];
  if (!frames.success) {
    critic = { status: "not_answered", reason: "the take has no valid frames for the Critic" };
  } else {
    const run = await runCritic(deps.role, {
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      reservationId: request.reservationId,
      attempt: request.attempt,
      signal: request.signal,
      input: { shotId: shot.shotId, visualType: shot.visualType, durationMs: request.takeDurationMs, frames: frames.data },
    });
    critic = run.outcome;
    calls = run.calls;
    alerts = run.alerts;
  }

  const outcome = takeGate({
    takeId: request.takeId,
    shot,
    measurements: request.measurements,
    similarity,
    critic,
    metrics: request.metrics,
  });
  return { ...outcome, calls, alerts, critic };
}
