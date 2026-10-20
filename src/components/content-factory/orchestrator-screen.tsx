import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { orchestratorPlanSchema, type NodeEvent, type OrchestratorPlan } from "@/engine/orchestrator/contracts";
import { examplePlanRaw } from "@/engine/orchestrator/fixtures/example-plan.ts";
import { exampleEvents } from "@/engine/orchestrator/fixtures/example-events.ts";
import { OrchestratorCanvas } from "./orchestrator-canvas";

const STEP_MS = 380;

const examplePlan: OrchestratorPlan = orchestratorPlanSchema.parse(examplePlanRaw);
const events: NodeEvent[] = exampleEvents;

/**
 * The orchestrator's canvas, replaying a recorded example run. The run was made from the example plan with stand-in handlers: no
 * model or provider is called, and the costs are the plan's estimates. A live run will replace the recording once the gateway is
 * connected and the owner's key is set. Nothing here reports a live result.
 */
export function OrchestratorScreen() {
  const [shown, setShown] = useState(0);
  const [playing, setPlaying] = useState(false);
  const total = events.length;
  const finished = shown >= total;

  const restart = () => {
    setShown(0);
    setPlaying(true);
  };

  useEffect(() => {
    if (!playing) return;
    if (shown >= total) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setShown((count) => count + 1), STEP_MS);
    return () => clearTimeout(timer);
  }, [playing, shown, total]);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Orchestrator plan (recorded example)</h1>
        <p className="text-sm text-fg-muted">
          A recorded run of the example plan. No model or provider was called; costs are the plan's estimates, not charges.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="md" onClick={finished ? restart : () => setPlaying(true)} disabled={playing}>
          {finished ? "Replay the run" : shown === 0 ? "Start the replay" : "Continue"}
        </Button>
        <Button size="md" variant="secondary" onClick={restart}>
          Restart
        </Button>
        <span className="text-xs text-fg-muted" aria-live="polite">
          {shown} of {total} events drawn
        </span>
      </div>

      <OrchestratorCanvas plan={examplePlan} events={events} shown={shown} />
    </div>
  );
}
