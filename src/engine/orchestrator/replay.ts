// What the canvas shows after the first `shown` events of a run. A step appears at its first event, and its state is its latest
// event. Playing a recorded run forward is this function with a growing `shown`. Pure.

import type { NodeEvent, NodeState } from "./contracts.ts";

export type ReplayStep = {
  state: NodeState;
  costUsd: number | null;
  reason: string | null;
  outputHash: string | null;
};

export function replayAt(events: NodeEvent[], shown: number): Map<string, ReplayStep> {
  const steps = new Map<string, ReplayStep>();
  for (const event of events.slice(0, Math.max(0, shown))) {
    steps.set(event.nodeId, {
      state: event.state,
      costUsd: event.costUsd,
      reason: event.reason,
      outputHash: event.outputHash,
    });
  }
  return steps;
}
