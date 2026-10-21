import { useEffect, useMemo, useRef, useState } from "react";
import type { NodeEvent, NodeState, OrchestratorPlan } from "@/engine/orchestrator/contracts";
import { NODE_HEIGHT, NODE_WIDTH, layoutPlan } from "@/engine/orchestrator/layout";
import { replayAt } from "@/engine/orchestrator/replay";
import { topologicalOrder } from "@/engine/orchestrator/validate";

/** The step's state in words. "NOT CONNECTED" is shown as it is: a step with no handler did not run and has no output. */
const STATE_LABEL: Record<NodeState, string> = {
  planned: "Planned",
  running: "Running",
  done: "Done",
  cache_hit: "Reused",
  skipped: "Skipped",
  failed: "Failed",
  not_connected: "NOT CONNECTED",
  paused: "Paused at budget",
};

const STATE_DOT: Record<NodeState, string> = {
  planned: "ring-2 ring-info",
  running: "bg-info motion-safe:animate-pulse",
  done: "bg-success",
  cache_hit: "bg-success",
  skipped: "bg-border-strong",
  failed: "bg-danger",
  not_connected: "bg-warning",
  paused: "bg-warning",
};

const usd = (value: number) => `$${value.toFixed(4)}`;

/**
 * The orchestrator's plan drawn as a flow. It starts as a plain canvas. `shown` is how many events of the run have arrived: each step
 * pops in at its first event, and the line into it draws itself. `stale` marks the steps an edit would run again: they are drawn with a
 * dashed border and labelled, whatever state their last run had. Pure drawing from the plan and the events; nothing here calls a model.
 */
export function OrchestratorCanvas({
  plan,
  events,
  shown,
  stale,
  showAll = false,
}: {
  plan: OrchestratorPlan | null;
  events: NodeEvent[];
  shown: number;
  stale?: ReadonlySet<string>;
  /** Draw every step and line, whether or not the replay has reached it: used while a plan is being edited. */
  showAll?: boolean;
}) {
  const drawn = useMemo(() => {
    if (plan === null) return null;
    const order = topologicalOrder(plan.nodes);
    if (order === null) return null;
    return layoutPlan(plan, order);
  }, [plan]);

  const replay = useMemo(() => replayAt(events, shown), [events, shown]);

  // The canvas fits the width it is given: a wide plan is scaled down to half its size at the least, and scrolls beyond that.
  const frame = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  useEffect(() => {
    const element = frame.current;
    if (element === null) return;
    setAvailable(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setAvailable(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const scale = drawn !== null && available > 0 ? Math.min(1, Math.max(0.5, available / drawn.width)) : 1;

  if (plan === null || drawn === null) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface p-6 text-sm text-fg-muted" role="status">
        No plan yet. The orchestrator draws its steps here as it plans them.
      </div>
    );
  }

  const visible = new Set(plan.nodes.filter((node) => showAll || replay.has(node.id)).map((node) => node.id));
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));

  return (
    <div ref={frame} className="overflow-auto rounded-lg border border-border bg-surface" role="region" aria-label="Orchestrator plan" style={{ height: drawn.height * scale + 2 }}>
      <div className="relative origin-top-left" style={{ width: drawn.width, height: drawn.height, transform: scale < 1 ? `scale(${scale})` : undefined }}>
        <svg className="absolute inset-0 text-border-strong" width={drawn.width} height={drawn.height} aria-hidden="true">
          {drawn.edges
            .filter((edge) => visible.has(edge.to))
            .map((edge) => (
              <path
                key={`${edge.from}->${edge.to}`}
                d={edge.d}
                pathLength={1}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                className="orch-edge"
              />
            ))}
        </svg>

        {drawn.nodes
          .filter((placed) => visible.has(placed.id) || stale?.has(placed.id))
          .map((placed) => {
            const step = replay.get(placed.id);
            const node = byId.get(placed.id);
            const isStale = stale?.has(placed.id) ?? false;
            if (!node || (!step && !isStale && !showAll)) return null;
            const state: NodeState = step?.state ?? "planned";
            return (
              <article
                key={placed.id}
                className={`orch-node absolute flex flex-col gap-1 rounded-lg bg-surface p-3 shadow-sm ${isStale ? "border-2 border-dashed border-warning" : "border border-border-strong"}`}
                style={{ left: placed.x, top: placed.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
                data-state={state}
                data-stale={isStale ? "true" : undefined}
              >
                <div className="flex items-center gap-2">
                  <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${isStale ? "ring-2 ring-warning" : STATE_DOT[state]}`} aria-hidden="true" />
                  <span className="truncate text-sm font-medium">{node.title}</span>
                </div>
                <div className="truncate text-xs text-fg-muted">{node.model ? node.model.id : `${node.kind}, no model call`}</div>
                <div className="mt-auto flex items-center justify-between text-xs">
                  <span>{isStale ? "To re-run" : STATE_LABEL[state]}</span>
                  <span className="text-fg-muted">
                    {step?.costUsd !== null && step?.costUsd !== undefined
                      ? usd(step.costUsd)
                      : node.estimateUsd !== null
                        ? `est. ${usd(node.estimateUsd)}`
                        : ""}
                  </span>
                </div>
                {step?.reason && !isStale ? (
                  <div className="truncate text-xs text-fg-muted" title={step.reason}>
                    {step.reason}
                  </div>
                ) : null}
              </article>
            );
          })}
      </div>

      <ol className="sr-only">
        {plan.nodes.map((node) => (
          <li key={node.id}>
            {node.title}: {stale?.has(node.id) ? "to re-run" : visible.has(node.id) ? STATE_LABEL[replay.get(node.id)?.state ?? "planned"] : "not drawn yet"}
          </li>
        ))}
      </ol>
    </div>
  );
}
