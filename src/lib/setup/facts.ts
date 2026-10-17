/**
 * Builds the guide's facts from the server's saved states. The provider rows and the engine status come from the same model the
 * Settings panel uses, so the guide and the panel can never disagree about a key.
 */
import { setupRows, type SetupEngines, type SetupInput } from "../../components/settings/setup-model.ts";
import type { GuideFacts } from "./guide.ts";

export function guideFacts(input: { brandCount: number | null; summaries: SetupInput["summaries"] | null; engines: SetupEngines | null }): GuideFacts {
  const { brandCount, summaries, engines } = input;
  const providers = summaries && engines ? setupRows({ summaries, engines }) : null;
  const active = engines?.engines.find((engine) => engine.id === engines.active.engineId);
  const engine = engines
    ? {
        label: active?.label ?? engines.active.engineId,
        // A workspace or deployment choice counts. The default does not, so a person still has to pick an engine that is ready.
        chosen: engines.active.source !== "default",
        ready: active?.health.status === "READY",
        reason: active?.health.message ?? "The engine did not report its state.",
      }
    : null;
  return {
    brandCount,
    engine,
    providers: providers ? Object.fromEntries(providers.map((row) => [row.id, row.status])) : null,
  };
}
