// Registers stage handlers on an engine runtime (Video Engine Bible 5.1). A stage with no handler stays not_implemented, so a
// composition root that registers only some stages still refuses the others rather than marking them done.

import { registerStageHandler } from "../dispatch.ts";
import type { EngineStage } from "../registry.ts";
import type { EngineRuntime, StageHandler } from "../types.ts";

export type EngineHandlerSet = Partial<Record<EngineStage, StageHandler>>;

/** Adds each handler of the set to the runtime, for its stage. Nothing else on the runtime changes. */
export function registerEngineHandlers(runtime: EngineRuntime, handlers: EngineHandlerSet): void {
  for (const stage of Object.keys(handlers) as EngineStage[]) {
    const handler = handlers[stage];
    if (handler) registerStageHandler(stage, handler, runtime);
  }
}
